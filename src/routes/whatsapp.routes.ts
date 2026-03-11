import { Router } from "express";
import { sendSimpleMessage } from "../controllers/whatsapp.controller";

const router = Router();

// 🚀 ROTA: Envio de Mensagem Simples (Ingressos, Alertas, Confirmações)
// Endpoint: POST /whatsapp/send-message
router.post("/send-message", sendSimpleMessage);

export default router;
