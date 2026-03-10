import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import webhookRoutes from "./routes/webhook.routes"; // <-- Importação das rotas que acabamos de criar

// Carrega as variáveis de ambiente
dotenv.config();

const app = express();
// Usamos a porta 3001 como padrão para o serviço de IA
const PORT = process.env.PORT || 3001;

// Middlewares essenciais
app.use(cors());
app.use(express.json());

// Rota de Health Check para garantir que a API está no ar
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "online",
    message: "🚀 Servidor de IA do ReservasClub operando 100%!",
  });
});

// Registrar a rota de Webhooks (A Evolution API vai bater em http://localhost:3001/webhooks/evolution)
app.use("/webhooks", webhookRoutes);

// Inicialização do servidor
app.listen(PORT, () => {
  console.log(`[Service-IA] Servidor rodando na porta ${PORT}`);
});
