import { ApiProperty } from '@nestjs/swagger';

export class PayRequestDto {
    @ApiProperty({
        description: 'The BOLT11 payment request (invoice) to pay',
        example: 'lnbc10u1p3...'
    })
    paymentRequest: string;
}
