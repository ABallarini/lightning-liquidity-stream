import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LndModule } from './lnd/lnd.module';
import { envValidationSchema } from './config/env.config';

@Module({
    imports: [
        ConfigModule.forRoot({
            validationSchema: envValidationSchema,
            isGlobal: true,
        }),
        LndModule,
    ],
})
export class AppModule { }
