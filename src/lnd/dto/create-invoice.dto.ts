import { ApiProperty } from '@nestjs/swagger';

export class CreateInvoiceDto {
    @ApiProperty({
        description: 'Amount in satoshis to request',
        example: 1000
    })
    amount: number;

    @ApiProperty({
        description: 'Optional memo for the invoice',
        example: 'Coffee payment',
        required: false
    })
    description?: string;
}
