export enum ChannelStatus {
    OK = 'OK',
    STUCK = 'STUCK',
}

export interface LiquidityReport {
    channelId: string;
    partnerPublicKey: string;
    localBalance: number;
    remoteBalance: number;
    capacity: number;
    outboundLiquidityRatio: number;
    inboundLiquidityRatio: number;
    status: ChannelStatus;
}

export interface FeasibilityReport {
    targetAmountSats: number;
    canSend: boolean;
    sendExplanation: string;
    canReceive: boolean;
    receiveExplanation: string;
}

export interface PaymentResult {
    success: boolean;
    paymentRequest: string;
    preimage?: string;
    feeSats?: number;
    fee_mtokens?: string;
    channels?: {
        channelId: string;
        fee_mtokens: string;
    }[];
    failureReason?: string;
    details: {
        tokens?: number;
        maxOutbound?: number;
        destination?: string;
        amount?: number;
    };
}

export interface InvoiceResult {
    paymentRequest: string;
    id: string;
    secret: string;
    tokens: number;
    description: string;
    createdAt: string;
}

export interface PaymentLogDetails {
    from: string;
    to: string;
    amount: number;
}
