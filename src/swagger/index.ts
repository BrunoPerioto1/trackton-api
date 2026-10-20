import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import basicAuth from 'express-basic-auth';

export function configureSwagger(app: INestApplication) {
  const swaggerUser = process.env.SWAGGER_USER ?? 'admin';
  const swaggerPassword = process.env.SWAGGER_PASSWORD;

  if (!swaggerPassword) {
    throw new Error('❌ SWAGGER_PASSWORD não definido no .env');
  }

  app.use(
    ['/doc', '/doc-json', '/doc-yaml'],
    basicAuth({
      users: { [swaggerUser]: swaggerPassword },
      challenge: true,
      realm: 'STS-SWAGGER',
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Trackton API')
    .setDescription(
      'Controle de apostas esportivas: banca, saldo por casa e análise de desempenho — ' +
        'com ingestão de bilhete por print, áudio ou texto de tip.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(undefined, 'Bearer Token')
    .addSecurityRequirements('Bearer Token')
    .addGlobalParameters({
      name: 'lang',
      in: 'header',
      required: true,
      schema: {
        enum: ['pt-br', 'en-us', 'es'],
        default: 'pt-br',
      },
    })
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('doc', app, document, {
    jsonDocumentUrl: 'doc-json',
    yamlDocumentUrl: 'doc-yaml',
    swaggerUiEnabled: false,
  });

  app.use(
    '/doc',
    apiReference({
      content: document,
      theme: 'default',
      layout: 'classic',
      title: 'Trackton API',
      cdn: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference',
    }),
  );
}
