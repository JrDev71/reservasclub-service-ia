import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { buildSystemContext } from "../utils/prompt-builder"; // 👈 Importamos o cozinheiro
import { ReservationService } from "./reservation-service"; // 👈 Importamos as regras de negócio

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private reservationService: ReservationService; // 👈 Instanciamos o serviço
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";
  private readonly MAIN_API_TOKEN = process.env.MAIN_API_TOKEN;

  private fallbackModels = [
    "gemini-3.5-flash", // 🚀 A estrela principal: O modelo Flash atual mais inteligente e rápido.
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
  ];

  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
    this.reservationService = new ReservationService(); // 👈 Iniciamos a ferramenta
  }

  private tools = [
    {
      functionDeclarations: [
        {
          name: "get_available_spaces",
          description: "Consulta setores disponíveis para uma data específica.",
          parameters: {
            type: "object",
            properties: {
              date: {
                type: "string",
                description: "A data no formato AAAA-MM-DD",
              },
            },
            required: ["date"],
          },
        },
        {
          name: "create_reservation",
          description:
            "⚠️ CRÍTICO: Usa esta função APENAS UMA VEZ após coletar nome, telefone e email do cliente. Após chamar, assuma que a reserva foi um SUCESSO ABSOLUTO. NUNCA chame 'get_available_spaces' novamente após criar a reserva. NUNCA chame esta função duas vezes na mesma conversa. Retorne a chave PIX imediatamente. Se for aniversário, defina isBirthday como true.",
          parameters: {
            type: "object",
            properties: {
              customerName: { type: "string" },
              customerPhone: { type: "string" },
              customerEmail: { type: "string" },
              date: {
                type: "string",
                description: "A data no formato AAAA-MM-DD",
              },
              spaceName: { type: "string" },
              isBirthday: {
                type: "boolean",
                description:
                  "Deve ser true SOMENTE SE o cliente expressamente disse que a reserva é para comemorar o próprio aniversário.",
              },
            },
            required: [
              "customerName",
              "customerPhone",
              "customerEmail",
              "date",
              "spaceName",
              "isBirthday", // Exigimos que a IA sempre envie essa flag
            ],
          },
        },
        {
          name: "check_reservation_status",
          description:
            "Consulta se o cliente já tem uma reserva ativa ou paga no sistema. Use SEMPRE que o cliente pedir a confirmação, voucher, ingresso ou perguntar se o pagamento foi aprovado.",
          parameters: {
            type: "object",
            properties: {
              contact: {
                type: "string",
                description:
                  "O número de telefone ou email do cliente para buscar a reserva.",
              },
            },
            required: ["contact"],
          },
        },
      ],
    },
  ];

  async generateResponse(
    nightclubId: string,
    customerPhone: string,
    message: string,
  ) {
    const requestId = Math.random().toString(36).substring(7).toUpperCase();
    console.log(
      `\n[${requestId}] 📨 NOVA MENSAGEM: ${customerPhone} -> "${message}"`,
    );

    console.log(
      `[${requestId}] 🕵️ DEDO-DURO: Atirando para -> ${this.MAIN_API_URL} com Token: ${this.MAIN_API_TOKEN ? "EXISTE" : "FALTOU!"}`,
    );

    try {
      const responseMain = await axios.get(
        `${this.MAIN_API_URL}/nightclubs/service-ia/${nightclubId}`,
        {
          headers: { "x-internal-key": this.MAIN_API_TOKEN },
        },
      );
      const nightclub = responseMain.data;

      if (!nightclub?.aiAgent?.isActive) {
        console.warn(
          `[${requestId}] ⚠️ Agente inativo ou balada não encontrada.`,
        );
        return null;
      }

      // 🍔 AQUI CHAMAMOS O CONSTRUTOR DE PROMPTS EXTERNO
      const systemContext = buildSystemContext(nightclub);

      const rawHistory = await prisma.aiMemory.findMany({
        where: { nightclubId, customerPhone },
        orderBy: { createdAt: "desc" },
        take: 12,
      });

      rawHistory.reverse();

      let formattedHistory = rawHistory.map((m: any) => ({
        role: m.role === "assistant" ? "model" : m.role,
        parts: [{ text: m.content }],
      }));

      while (
        formattedHistory.length > 0 &&
        formattedHistory[0].role !== "user"
      ) {
        formattedHistory.shift();
      }

      let lastErrorType = "";

      for (const modelName of this.fallbackModels) {
        try {
          console.log(`[${requestId}] 🧠 Tentando modelo: ${modelName}`);

          const model = this.genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: systemContext,
            tools: this.tools as any,
          });

          const chat = model.startChat({ history: formattedHistory });

          let result = await chat.sendMessage(message);
          let chatResponse = result.response;
          let call = chatResponse.functionCalls()?.[0];
          let finalResponseText = chatResponse.text() || "";

          while (call) {
            console.log(`[${requestId}] 🛠️ IA usou: ${call.name}`);
            const args: any = call.args;
            let functionResult = "";

            // 🧰 AQUI CHAMAMOS O SERVIÇO DE RESERVAS
            if (call.name === "get_available_spaces") {
              functionResult = await this.reservationService.getAvailableSpaces(
                nightclubId,
                args.date,
                requestId,
              );
            } else if (call.name === "create_reservation") {
              functionResult =
                await this.reservationService.createReservationAndPayment(
                  nightclubId,
                  args,
                  requestId,
                  customerPhone,
                );
            } else if (call.name === "check_reservation_status") {
              // 🔍 Executa a busca da reserva existente para evitar Overbooking
              functionResult =
                await this.reservationService.checkReservationStatus(
                  nightclubId,
                  args.contact,
                  customerPhone,
                );
            }

            const nextStep = await chat.sendMessage([
              {
                functionResponse: {
                  name: call.name,
                  response: { content: functionResult },
                },
              },
            ]);

            chatResponse = nextStep.response;
            call = chatResponse.functionCalls()?.[0];

            if (!call) {
              finalResponseText = chatResponse.text();
            }
          }

          // Salva histórico no banco
          await prisma.aiMemory.createMany({
            data: [
              { nightclubId, customerPhone, role: "user", content: message },
              {
                nightclubId,
                customerPhone,
                role: "model",
                content: finalResponseText,
              },
            ],
          });

          console.log(`[${requestId}] ✅ SUCESSO (${modelName})`);
          return finalResponseText;
        } catch (error: any) {
          const isQuota =
            error.message.includes("429") || error.message.includes("Quota");
          if (isQuota) lastErrorType = "QUOTA_EXCEEDED";

          console.warn(
            `[${requestId}] ⚠️ Falha no ${modelName}: ${isQuota ? "Cota estourada (429)" : error.message.split("\n")[0]}`,
          );
          continue;
        }
      }

      if (lastErrorType === "QUOTA_EXCEEDED") {
        console.error(
          `[${requestId}] 🚨 ALERTA CRÍTICO: Todas as tentativas falharam por falta de cota no Google API.`,
        );
      }
      return "Estou com uma fila de espera grande no momento. Pode me enviar um 'Oi' novamente em 1 minuto?";
    } catch (e: any) {
      console.error(`[${requestId}] 🚨 ERRO SISTÊMICO: ${e.message}`);
      return null;
    }
  }
}
