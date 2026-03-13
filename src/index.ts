import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser"; // 👈 O salvador da pátria

import webhookRoutes from "./routes/webhook.routes";
import instanceRoutes from "./routes/instance.routes";
import whatsappRoutes from "./routes/whatsapp.routes";

// Carrega as variáveis de ambiente
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================================
// 🚪 ABRINDO OS PORTÕES COM BODY-PARSER: Forçando o limite absurdo ANTES de tudo
// ============================================================================
// Isso garante que se a Evolution mandar 100MB de contatos num payload só, a gente aceita.
app.use(bodyParser.json({ limit: "100mb" }));
app.use(
  bodyParser.urlencoded({
    limit: "100mb",
    extended: true,
    parameterLimit: 1000000,
  }),
);

// Middlewares adicionais
app.use(cors());

// Rota de Health Check
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "online",
    message: "🚀 Servidor de IA do ReservasClub operando 100%!",
  });
});

// Registrar Rotas
app.use("/webhooks", webhookRoutes);
app.use("/instances", instanceRoutes);
app.use("/whatsapp", whatsappRoutes);

// Inicialização
app.listen(PORT, () => {
  console.log(`[Service-IA] Servidor rodando na porta ${PORT}`);
});
