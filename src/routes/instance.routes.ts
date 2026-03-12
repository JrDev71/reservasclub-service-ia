import { Router } from "express";
import {
  createNightclubInstance,
  connectNightclubInstance,
  connectNightclubWithCode, // 🔢 Importação fresquinha aqui!
} from "../controllers/instance.controller";

const router = Router();

// Rota para criar a instância e gerar o QR Code a primeira vez (POST /instances/create)
router.post("/create", createNightclubInstance);

// 🔄 Rota de Fallback para reconectar/puxar QR Code de instância já existente
router.get("/connect/:nightclubId", connectNightclubInstance);

// 🔢 NOVA ROTA: Conectar via Código de Pareamento (Pairing Code)
router.post("/connect-code", connectNightclubWithCode);

export default router;
