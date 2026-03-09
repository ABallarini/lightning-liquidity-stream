import { Injectable, OnModuleInit, Logger, BadRequestException, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { appendFile, readFile, writeFile } from 'fs/promises';
import { authenticatedLndGrpc, getWalletInfo, getChannels, decodePaymentRequest, pay, createInvoice, GetWalletInfoResult, GetChannelsResult, DecodePaymentRequestResult, PayResult } from 'lightning';
import { ChannelStatus, FeasibilityReport, InvoiceResult, LiquidityReport, PaymentLogDetails, PaymentResult } from './interfaces/lnd-service.interface';

@Injectable()
export class LndService implements OnModuleInit {
    private readonly logger = new Logger(LndService.name);
    private lndInstance: any;
    private nodePubkey: string;

    constructor(private readonly configService: ConfigService) { }

    /**
     * Called once the module has been initialized. 
     * Authenticates with LND and verifies the connection.
     */
    public async onModuleInit(): Promise<void> {
        this.logger.log('Initializing LND Service...');

        try {
            this.authenticate();
            await this.verifyConnection();
        } catch (error) {
            this.logger.warn('Warning: Failed to initialize or connect to the LND node (it may be locked or syncing). App will continue running.', error);
        }
    }

    /**
     * Authenticates with the gRPC interface of the LND node using TLS cert and admin macaroon.
     * Gets sensitive values safely from the ConfigService environment variables.
     */
    private authenticate(): void {
        const socket = this.configService.get<string>('LND_SOCKET');
        const certPath = this.configService.get<string>('LND_CERT_PATH');
        const macaroonPath = this.configService.get<string>('LND_MACAROON_PATH');

        if (!socket || !certPath || !macaroonPath) {
            throw new Error('LND configuration is missing valid environment variables.');
        }

        try {
            // The lightning library expects the cert and macaroon as base64 strings
            const cert = readFileSync(certPath, 'base64');
            const macaroon = readFileSync(macaroonPath, 'base64');

            const { lnd } = authenticatedLndGrpc({
                cert,
                macaroon,
                socket,
            });

            this.lndInstance = lnd;
            this.logger.log(`Successfully authenticated with LND gRPC node at ${socket}.`);
        } catch (error) {
            this.logger.error(`Failed to authenticate with LND gRPC node at ${socket}: ${error.message}`);
            throw new BadRequestException('Failed to authenticate with LND gRPC node.');
        }
    }

    /**
     * Verifies the connection by fetching wallet information from the authenticated LND node.
     */
    private async verifyConnection(): Promise<void> {
        if (!this.lndInstance) {
            throw new Error('LND instance is not available for verification.');
        }

        try {
            const walletInfo = await this.getInfo();
            this.nodePubkey = walletInfo.public_key || 'Unknown';

            this.logger.log(
                `Connected to LND node. ` +
                `Alias: ${walletInfo.alias || 'Unknown'}, ` +
                `Network: ${walletInfo.chains?.[0] || 'Unknown'}, ` +
                `Version: ${walletInfo.version}`
            );
        } catch (error) {
            this.logger.error(`Failed to verify connection: ${error.message}`);
            throw new BadRequestException('Failed to verify connection to LND node.');
        }
    }

    /**
     * Fetches detailed information about the connected LND node.
     */
    public async getInfo(): Promise<GetWalletInfoResult> {
        this.logger.log('Fetching detailed information about the connected LND node...');
        if (!this.lndInstance) {
            this.logger.error('Cannot fetch info: LND instance is not available.');
            throw new NotFoundException('LND instance is not available.');
        }
        try {
            const info: GetWalletInfoResult = await getWalletInfo({ lnd: this.lndInstance });
            this.logger.log(`Successfully retrieved node info. Node Alias: ${info.alias}`);
            return info;
        } catch (error: any) {
            this.logger.error(`Error retrieving node info: ${error.message}`);
            throw new BadRequestException('Failed to retrieve node info.');
        }
    }

    /**
     * Fetches all open channels and calculates the liquidity report.
     * Calculates the ratio of local_balance to remote_balance, and marks channels
     * as 'STUCK' if liquidity is 100% on one side.
     */
    public async getLiquidityReport(): Promise<LiquidityReport[]> {
        this.logger.log('Generating liquidity report for all open channels...');
        if (!this.lndInstance) {
            this.logger.error('Cannot generate liquidity report: LND instance is not available.');
            throw new NotFoundException('LND instance is not available.');
        }

        try {
            const { channels }: GetChannelsResult = await getChannels({ lnd: this.lndInstance });
            this.logger.log(`Successfully retrieved ${channels.length} open channels.`);

            let stuckCount = 0;

            const report = channels.map((channel: GetChannelsResult['channels'][number]) => {
                const localBalance = channel.local_balance;
                const remoteBalance = channel.remote_balance;

                // Calculate outbound and inbound liquidity ratios
                const outboundLiquidityRatio = channel.capacity === 0 ? 0 : localBalance / channel.capacity;
                const inboundLiquidityRatio = channel.capacity === 0 ? 0 : remoteBalance / channel.capacity;

                // Mark as STUCK if 100% of liquidity is on one side (either local is 0 or remote is 0)
                const isStuck = localBalance === 0 || remoteBalance === 0;

                if (isStuck) {
                    stuckCount++;
                    this.logger.warn(`Channel [${channel.id}] is STUCK. Local: ${localBalance}, Remote: ${remoteBalance}`);
                }

                return {
                    channelId: channel.id,
                    partnerPublicKey: channel.partner_public_key,
                    localBalance,
                    remoteBalance,
                    capacity: channel.capacity,
                    outboundLiquidityRatio,
                    inboundLiquidityRatio,
                    status: isStuck ? ChannelStatus.STUCK : ChannelStatus.OK,
                };
            });

            this.logger.log(`Liquidity report generated successfully. Found ${stuckCount} stuck channels out of ${channels.length} total.`);
            return report;
        } catch (error: any) {
            this.logger.error(`Error generating liquidity report: ${error.message}`);
            throw new InternalServerErrorException('Failed to generate liquidity report.');
        }
    }

    /**
     * Checks if the node can send or receive a specific target amount based on channel states.
     */
    public async checkPaymentFeasibility(amountSats: number): Promise<FeasibilityReport> {
        this.logger.log(`Checking feasibility for amount: ${amountSats} sats`);
        if (!this.lndInstance) {
            this.logger.error('Cannot check feasibility: LND instance is not available.');
            throw new NotFoundException('LND instance is not available.');
        }

        try {
            const { channels } = await getChannels({ lnd: this.lndInstance });

            // compute max outbound and inbound liquidity in order to check if the node can send or receive a specific target amount in some specific channel
            const maxOutbound = channels.reduce((max: number, channel: GetChannelsResult['channels'][number]) => Math.max(max, channel.local_balance), 0);
            const maxInbound = channels.reduce((max: number, channel: GetChannelsResult['channels'][number]) => Math.max(max, channel.remote_balance), 0);

            // check if the node can send or receive the target amount
            const canSend = amountSats <= maxOutbound;
            const canReceive = amountSats <= maxInbound;

            // return the feasibility report
            return {
                targetAmountSats: amountSats,
                canSend,
                sendExplanation: canSend
                    ? `Node can send ${amountSats} sats because a channel has outbound capacity of ${maxOutbound} sats.`
                    : `Node cannot send ${amountSats} sats. Max outbound on any single channel is ${maxOutbound} sats.`,
                canReceive,
                receiveExplanation: canReceive
                    ? `Node can receive ${amountSats} sats because a channel has inbound capacity of ${maxInbound} sats.`
                    : `Node cannot receive ${amountSats} sats. Max inbound on any single channel is ${maxInbound} sats.`
            };
        } catch (error: any) {
            this.logger.error(`Error checking feasibility: ${error.message}`);
            throw new InternalServerErrorException('Failed to check feasibility.');
        }
    }

    /**
     * Send a payment to a node.
     * Respects liquidity constraints and captures preimage, fees, and failures from the BOLT11 payment.
     */
    public async sendPayment(paymentRequest: string): Promise<PaymentResult> {
        this.logger.log('Executing payment attempt...');
        if (!this.lndInstance) {
            this.logger.error('Cannot send payment: LND instance is not available.');
            throw new NotFoundException('LND instance is not available.');
        }

        // initialize variables for payment details
        let destination = 'Unknown';
        let tokens = 0;

        try {
            // Decode to get internal details for logging and constraint checking
            const decoded: DecodePaymentRequestResult = await decodePaymentRequest({ lnd: this.lndInstance, request: paymentRequest });
            tokens = decoded.tokens;
            destination = decoded.destination;

            // Constraint Check: Max Outbound Capacity
            const { channels }: GetChannelsResult = await getChannels({ lnd: this.lndInstance });
            const maxOutbound = channels.reduce((max: number, channel: GetChannelsResult['channels'][number]) => Math.max(max, channel.local_balance), 0);

            // check if the node can send the target amount
            if (tokens > maxOutbound) {
                const reason = `INSUFFICIENT_LOCAL_LIQUIDITY: Amount (${tokens} sats) exceeds max outbound capacity of any single channel (${maxOutbound} sats).`;
                await this.logPaymentAttempt({ request: paymentRequest, success: false, preimage: null, errorReason: reason, fee: null, details: { from: this.nodePubkey, to: destination, amount: tokens } });
                return {
                    success: false,
                    paymentRequest,
                    failureReason: reason,
                    details: { tokens, maxOutbound, destination }
                };
            }

            // Execute Payment
            const result = await pay({ lnd: this.lndInstance, request: paymentRequest });

            // Capture Success Details
            const successResult = {
                success: true,
                paymentRequest,
                preimage: result.secret,
                // Safe fee is the fee rounded up to the nearest satoshi (in case of failure, the node will not lose more than this amount)
                feeSats: result.safe_fee,
                // Correct and precise fee in milisatoshis
                fee_mtokens: result.fee_mtokens,
                // Channels used for the payment
                channels: [
                    ...result.hops.map((hop: PayResult['hops'][number]) => {
                        return {
                            channelId: hop.channel,
                            fee_mtokens: hop.fee_mtokens,
                        }
                    }),
                ],
                details: { destination, amount: tokens }
            };

            this.logger.log(`Payment successful. Preimage: ${result.secret}, Fee: ${result.safe_fee} sats`);
            await this.logPaymentAttempt({ request: paymentRequest, success: true, preimage: result.secret, errorReason: null, fee: result.safe_fee, details: { from: this.nodePubkey, to: destination, amount: tokens } });

            return successResult;

        } catch (error: any) {
            // Capture Failure Reason
            const rawError = Array.isArray(error) ? error[1] : error.message;
            const failureReason = rawError || 'Unknown gRPC error';

            this.logger.error(`Payment failed: ${failureReason}`);

            const failureResult = {
                success: false,
                paymentRequest,
                failureReason,
                details: { destination, amount: tokens }
            };

            await this.logPaymentAttempt({ request: paymentRequest, success: false, preimage: null, errorReason: failureReason, fee: null, details: { from: this.nodePubkey, to: destination, amount: tokens } });

            return failureResult;
        }
    }

    /**
     * Create a new BOLT11 invoice to receive funds.
     */
    public async createInvoice(amountSats: number, description?: string): Promise<InvoiceResult> {
        this.logger.log(`Creating invoice for ${amountSats} sats...`);
        if (!this.lndInstance) {
            throw new Error('LND instance is not available.');
        }

        try {
            const result = await createInvoice({
                lnd: this.lndInstance,
                tokens: amountSats,
                description: description || 'Orchestrator Generated Invoice'
            });

            this.logger.log(`Invoice created successfully: ${result.request}`);
            return {
                paymentRequest: result.request,
                id: result.id,
                secret: result.secret,
                tokens: result.tokens,
                description: result.description,
                createdAt: result.created_at
            };
        } catch (error: any) {
            this.logger.error(`Failed to create invoice: ${error.message}`);
            throw error;
        }
    }

    /**
     * Helper to write structured JSON logs (Task 5)
     */
    private async logPaymentAttempt(

        {
            request,
            success,
            preimage,
            errorReason,
            fee,
            details
        }: {
            request: string;
            success: boolean;
            preimage: string | null;
            errorReason: string | null;
            fee: number | null;
            details?: { from?: string; to?: string; amount?: number };
        }
    ) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            fromNode: details?.from || this.nodePubkey,
            toNode: details?.to || 'Unknown',
            amountSats: details?.amount || 0,
            request,
            success,
            preimage,
            fee,
            errorReason
        };

        const logFilePath = 'payment-logs.json';

        try {
            let logs = [];
            try {
                const data = await readFile(logFilePath, 'utf8');
                logs = JSON.parse(data);
                if (!Array.isArray(logs)) {
                    logs = [];
                }
            } catch (err) {
                // If file doesn't exist or is corrupted, start with empty array
                logs = [];
            }

            logs.push(logEntry);
            await writeFile(logFilePath, JSON.stringify(logs, null, 2), 'utf8');
        } catch (fsError) {
            this.logger.error('Failed to write to payment-logs.json', fsError);
        }
    }
}
