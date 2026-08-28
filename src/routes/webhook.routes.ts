import { Router } from "express";
import { handleEvolutionWebhook } from "../controllers/webhook.controller";

const router = Router();

// 👇 AQUI A CORREÇÃO: Mudamos de "/evolution" para "/webhook"
router.post("/webhook", handleEvolutionWebhook);

export default router;
