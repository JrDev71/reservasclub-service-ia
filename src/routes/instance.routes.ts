import { Router } from "express";
import {
  createNightclubInstance,
  connectNightclubInstance,
} from "../controllers/instance.controller";

const router = Router();

// Rota para criar a instância e gerar o QR Code a primeira vez (POST /instances/create)
router.post("/create", createNightclubInstance);

// 🔄 NOVA ROTA: Rota de Fallback para reconectar/puxar QR Code de instância já existente
router.get("/connect/:nightclubId", connectNightclubInstance);

export default router;
