import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import webhookRoutes from "./routes/webhook.routes";
import instanceRoutes from "./routes/instance.routes";
import whatsappRoutes from "./routes/whatsapp.routes"; // 👈 Adicionado: Rota de envio

// Carrega as variáveis de ambiente
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

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
app.use("/whatsapp", whatsappRoutes); // 👈 Registrado: POST /whatsapp/send-message

// Inicialização
app.listen(PORT, () => {
  console.log(`[Service-IA] Servidor rodando na porta ${PORT}`);
});
