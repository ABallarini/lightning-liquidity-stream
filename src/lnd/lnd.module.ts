import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LndService } from './lnd.service';
import { LndController } from './lnd.controller';

@Module({
    imports: [ConfigModule],
    controllers: [LndController],
    providers: [LndService],
    exports: [LndService],
})
export class LndModule { }
