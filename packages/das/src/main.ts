import { NestFactory } from "@nestjs/core";
import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { json } from "express";

const setupSwagger = (app: INestApplication): void => {
  const config = new DocumentBuilder()
    .setTitle("GitHub Mirror DAS")
    .setDescription("GitHub Mirror Data Access Service for Gittensor")
    .setVersion("1.0")
    .addApiKey({ type: "apiKey", name: "x-api-key", in: "header" }, "api-key")
    .build();

  const isProd = process.env.NODE_ENV === "production";

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("swagger", app, document, {
    swaggerOptions: {
      supportedSubmitMethods: isProd ? [] : ["get", "post"],
    },
  });
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Preserve raw body for webhook signature verification
  app.use(
    json({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      verify: (req: any, _res: any, buf: Buffer) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: "GET",
    allowedHeaders: "Content-Type, x-api-key",
  });

  setupSwagger(app);

  const port = process.env.API_PORT || 3000;

  await app.listen(port, () => {
    console.log("listening on port", port);
  });
}
void bootstrap();
