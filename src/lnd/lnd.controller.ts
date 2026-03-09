import { Controller, Get, Post, Body, Param, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { LndService } from './lnd.service';
import { PayRequestDto } from './dto/pay-request.dto';
import { CreateInvoiceDto } from './dto/create-invoice.dto';

@ApiTags('LND')
@Controller('lnd')
export class LndController {
    private readonly logger = new Logger(LndController.name);

    constructor(private readonly lndService: LndService) { }

    /**
     * Retrieves full information about the connected LND node.
     * Route: GET /lnd/info
     */
    @Get('info')
    @ApiOperation({ summary: 'Get LND node information' })
    @ApiResponse({ status: 200, description: 'Successfully retrieved node information.' })
    @ApiResponse({ status: 500, description: 'Internal server error.' })
    async getInfo() {
        this.logger.log('Received request: GET /lnd/info');
        try {
            const info = await this.lndService.getInfo();
            this.logger.log('Successfully processed GET /lnd/info');
            return info;
        } catch (error: any) {
            this.logger.error(`Failed to process GET /lnd/info: ${error.message}`, error.stack);
            throw new HttpException(
                error.message || 'Failed to fetch LND node info',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    /**
     * Retrieves the liquidity report for all open channels.
     * Route: GET /lnd/liquidity
     */
    @Get('liquidity')
    @ApiOperation({ summary: 'Get channel liquidity report' })
    @ApiResponse({ status: 200, description: 'Successfully retrieved liquidity report.' })
    @ApiResponse({ status: 500, description: 'Internal server error.' })
    async getLiquidityReport() {
        this.logger.log('Received request: GET /lnd/liquidity');
        try {
            const report = await this.lndService.getLiquidityReport();
            this.logger.log('Successfully processed GET /lnd/liquidity');
            return report;
        } catch (error: any) {
            this.logger.error(`Failed to process GET /lnd/liquidity: ${error.message}`, error.stack);
            throw new HttpException(
                error.message || 'Failed to fetch liquidity report',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    /**
     * Checks the feasibility of sending/receiving a target amount.
     * Route: GET /lnd/feasibility/:amount
     */
    @Get('feasibility/:amount')
    @ApiOperation({ summary: 'Check feasibility of sending/receiving a target amount (sats)' })
    @ApiResponse({ status: 200, description: 'Successfully checked feasibility.' })
    @ApiResponse({ status: 500, description: 'Internal server error.' })
    async checkFeasibility(@Param('amount') amount: string) {
        this.logger.log(`Received request: GET /lnd/feasibility/${amount}`);
        try {
            const amountSats = parseInt(amount, 10);
            if (isNaN(amountSats)) {
                throw new Error('Invalid amount provided.');
            }
            const feasibility = await this.lndService.checkPaymentFeasibility(amountSats);
            this.logger.log(`Successfully processed GET /lnd/feasibility/${amount}`);
            return feasibility;
        } catch (error: any) {
            this.logger.error(`Failed to process GET /lnd/feasibility/${amount}: ${error.message}`);
            throw new HttpException(
                error.message || 'Failed to check feasibility',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    /**
     * Executes a payment attempt passing in input the BOLT11 payment request.
     * Route: POST /lnd/pay
     */
    @Post('pay')
    @ApiOperation({ summary: 'Execute a payment given a payment request' })
    @ApiBody({ type: PayRequestDto })
    @ApiResponse({ status: 201, description: 'Successfully executed payment.' })
    @ApiResponse({ status: 500, description: 'Internal server error.' })
    async payRequest(@Body() payRequestDto: PayRequestDto) {
        this.logger.log('Payment request received via API orchestrator.');
        try {
            const { paymentRequest } = payRequestDto;
            if (!paymentRequest) {
                return {
                    success: false,
                    failureReason: 'Payment request is required.'
                };
            }

            const result = await this.lndService.sendPayment(paymentRequest);

            if (result.success) {
                this.logger.log('Payment attempt completed successfully.');
            } else {
                this.logger.warn(`Payment attempt failed: ${result.failureReason}`);
            }

            return result;
        } catch (error: any) {
            this.logger.error(`Critical error during payment orchestration: ${error.message}`);
            throw new HttpException(
                'Critical error during payment orchestration. Check server logs.',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Post('invoice')
    @ApiOperation({ summary: 'Create a new BOLT11 invoice to receive funds' })
    @ApiResponse({ status: 201, description: 'Successfully created invoice.' })
    async createInvoice(@Body() createInvoiceDto: CreateInvoiceDto) {
        this.logger.log('Invoice generation request received.');
        try {
            const { amount, description } = createInvoiceDto;
            const result = await this.lndService.createInvoice(amount, description);
            return result;
        } catch (error: any) {
            this.logger.error(`Failed to create invoice: ${error.message}`);
            throw new HttpException(
                error.message || 'Failed to create invoice',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }
}
