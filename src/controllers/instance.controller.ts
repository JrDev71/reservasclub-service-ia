import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import axios from "axios";
import {
  criarInstancia,
  conectarInstancia,
  conectarInstanciaComCodigo,
} from "../services/evolution.service";

// ============================================================================
// 🕰️ FUNÇÃO AUXILIAR: A GUILHOTINA SUAVE DE 45 SEGUNDOS
// ============================================================================
const iniciarCronometroCancelamento = (instanceName: string) => {
  setTimeout(async () => {
    try {
      const instancia = await prisma.whatsappInstance.findUnique({
        where: { instanceName },
      });

      if (
        instancia &&
        (instancia.status === "QRCODE" || instancia.status === "CONNECTING")
      ) {
        console.log(
          `[Timer] ⏰ 45s passaram. Conexão não concluída para ${instanceName}.`,
        );

        // Em vez de obliterar e quebrar o DB, a gente só desloga pra parar o motor
        const EVOLUTION_API_URL =
          process.env.EVOLUTION_API_URL || "http://localhost:8080";
        const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";
        await axios
          .delete(`${EVOLUTION_API_URL}/instance/logout/${instanceName}`, {
            headers: { apikey: EVOLUTION_API_KEY },
            timeout: 5000,
          })
          .catch(() => {});

        await prisma.whatsappInstance.update({
          where: { instanceName },
          data: { status: "DISCONNECTED", qrCode: null },
        });
        console.log(
          `[Timer] 🛑 Instância ${instanceName} resetada para DISCONNECTED no banco.`,
        );
      }
    } catch (error: any) {
      console.error(
        `[Timer Error] Falha ao abortar conexão de ${instanceName}:`,
        error.message,
      );
    }
  }, 45000);
};

// ============================================================================
// 1. CRIAÇÃO DE NOVA INSTÂNCIA (QR Code Padrão)
// ============================================================================
export const createNightclubInstance = async (req: Request, res: Response) => {
  try {
    const { nightclubId } = req.body;
    if (!nightclubId) return res.status(400).json({ error: "ID obrigatório." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });
    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(`\n[Instance] Iniciando fluxo de Criação: ${instanceName}`);

    // Cria ou Recicla a instância
    const evolutionResponse = await criarInstancia(instanceName);

    let qrCodeBase64 = evolutionResponse?.qrcode?.base64 || null;

    // Se ela foi reciclada, o QR Code não vem na criação, temos que buscar manual na rota connect
    if (evolutionResponse?.recycled || !qrCodeBase64) {
      console.log(`[Instance] Buscando QR Code na instância reciclada...`);
      const connectRes = await conectarInstancia(instanceName);
      qrCodeBase64 = connectRes?.base64 || connectRes?.qrcode?.base64 || null;
    }

    const whatsappInstance = await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: {
        status: "QRCODE",
        qrCode: qrCodeBase64,
        nightclubId: nightclub.id,
      },
      create: {
        instanceName,
        status: "QRCODE",
        qrCode: qrCodeBase64,
        nightclubId: nightclub.id,
      },
    });

    iniciarCronometroCancelamento(instanceName);

    return res.status(200).json({ success: true, instance: whatsappInstance });
  } catch (error: any) {
    console.error("[Instance Controller Error]", error.message || error);
    return res
      .status(500)
      .json({ error: "Erro ao criar ou resetar a instância." });
  }
};

// ============================================================================
// 2. RECONEXÃO / FALLBACK (VIA QR CODE TRADICIONAL)
// ============================================================================
export const connectNightclubInstance = async (req: Request, res: Response) => {
  try {
    const { nightclubId } = req.params;
    if (!nightclubId) return res.status(400).json({ error: "ID obrigatório." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });
    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `\n[Instance] 🔄 Iniciando Fluxo de QR Code para: ${instanceName}`,
    );

    // Cria ou Recicla a instância
    const evolutionResponse = await criarInstancia(instanceName);

    let qrCodeBase64 = evolutionResponse?.qrcode?.base64 || null;

    if (evolutionResponse?.recycled || !qrCodeBase64) {
      console.log(`[Instance] Buscando QR Code na instância reciclada...`);
      const connectRes = await conectarInstancia(instanceName);
      qrCodeBase64 = connectRes?.base64 || connectRes?.qrcode?.base64 || null;
    }

    const initialStatus = qrCodeBase64 ? "QRCODE" : "CONNECTING";

    const whatsappInstance = await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: { status: initialStatus, qrCode: qrCodeBase64 },
      create: {
        instanceName,
        nightclubId: nightclub.id,
        status: initialStatus,
        qrCode: qrCodeBase64,
      },
    });

    iniciarCronometroCancelamento(instanceName);

    return res.status(200).json({ success: true, instance: whatsappInstance });
  } catch (error: any) {
    console.error("[Instance Connect Error]", error.message || error);
    return res
      .status(500)
      .json({ error: "Erro ao reconectar a instância. Tente novamente." });
  }
};

// ============================================================================
// 3. 🔢 RECONEXÃO VIA CÓDIGO DE PAREAMENTO
// ============================================================================
export const connectNightclubWithCode = async (req: Request, res: Response) => {
  try {
    const { nightclubId, number } = req.body;
    if (!nightclubId || !number)
      return res.status(400).json({ error: "ID e número são obrigatórios." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });
    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `\n[Instance] 🔢 Iniciando Pairing Code para: ${instanceName} / Número: ${number}`,
    );

    // Cria ou Recicla a instância enviando o número no payload
    const evolutionResponse = await criarInstancia(instanceName, number);

    // Captura o código numérico no retorno da criação (caso venha rápido)
    let pairingCode =
      evolutionResponse?.pairingCode ||
      evolutionResponse?.code ||
      evolutionResponse?.qrcode?.code ||
      null;

    // 🔥 4. A RESPIRAÇÃO: Se não vier o código na hora, espera o Baileys esquentar
    if (evolutionResponse?.recycled || !pairingCode) {
      console.log(
        "[Instance] ⏱️ Aguardando motor do Baileys iniciar (5s) para gerar o código...",
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));

      console.log(
        "[Instance] Forçando busca manual do código após aquecimento...",
      );
      const codeRes = await conectarInstanciaComCodigo(instanceName, number);
      pairingCode =
        codeRes?.pairingCode || codeRes?.code || codeRes?.qrcode?.code;

      // Se a Evolution estiver lenta, tenta uma última vez depois de mais 3 segundos
      if (!pairingCode) {
        console.log("[Instance] ⏱️ Segunda tentativa de busca (3s)...");
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const codeRes2 = await conectarInstanciaComCodigo(instanceName, number);
        pairingCode =
          codeRes2?.pairingCode || codeRes2?.code || codeRes2?.qrcode?.code;
      }
    }

    if (!pairingCode) {
      console.error(`[CRÍTICO] Evolution não gerou o código de 8 dígitos!`);
      throw new Error(
        "Evolution não retornou o código. Verifique se o número possui WhatsApp ativo e se o DDD está correto.",
      );
    }

    await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: { status: "CONNECTING", qrCode: null },
      create: {
        instanceName,
        nightclubId: nightclub.id,
        status: "CONNECTING",
        qrCode: null,
      },
    });

    iniciarCronometroCancelamento(instanceName);

    console.log(
      `[Instance] ✅ Código de Pareamento finalizado e pronto: ${pairingCode}`,
    );

    return res.status(200).json({ success: true, code: pairingCode });
  } catch (error: any) {
    console.error("[Instance Connect Code Error]", error.message || error);
    return res.status(500).json({
      error: error.message || "Erro ao gerar código de pareamento.",
    });
  }
};
