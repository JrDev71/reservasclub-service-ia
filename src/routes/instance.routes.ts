import { Router } from "express";
import { createNightclubInstance } from "../controllers/instance.controller";

const router = Router();

// Rota para criar a instância e gerar o QR Code (POST /instances/create)
router.post("/create", createNightclubInstance);

export default router;
