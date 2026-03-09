import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    // Setup Swagger
    const config = new DocumentBuilder()
        .setTitle('LND Integration API')
        .setDescription('API to interact with Dockerized LND node on Signet')
        .setVersion('1.0')
        .build();
    const documentFactory = () => SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, documentFactory);

    const port = process.env.PORT || 3000;
    await app.listen(port, '0.0.0.0');

    console.log(`Application is running on: ${await app.getUrl()}`);
    console.log(`Swagger documentation is available at: ${await app.getUrl()}/api`);
}
bootstrap();
