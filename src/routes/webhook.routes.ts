import { Router } from "express";
import { handleEvolutionWebhook } from "../controllers/webhook.controller";

const router = Router();

// Rota POST que a Evolution API vai chamar sempre que houver um evento (nova mensagem, status, etc)
router.post("/evolution", handleEvolutionWebhook);

export default router;
