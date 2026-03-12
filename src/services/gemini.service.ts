import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { startOfDay, format } from "date-fns";
import { enviarMediaWhatsApp } from "./evolution.service";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";
  private readonly MAIN_API_TOKEN = process.env.MAIN_API_TOKEN;

  private fallbackModels = [
    "gemini-2.5-flash",
    "gemini-1.5-flash",
    "gemini-flash-latest",
  ];

  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
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
          description: "Cria reserva e gera PIX.",
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
            },
            required: [
              "customerName",
              "customerPhone",
              "customerEmail",
              "date",
              "spaceName",
            ],
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

      // 🧠 1. MONTA E IMPRIME O PROMPT DO PAINEL
      const systemContext = this.buildSystemContext(nightclub);

      // 2. Busca o histórico
      const rawHistory = await prisma.aiMemory.findMany({
        where: { nightclubId, customerPhone },
        orderBy: { createdAt: "desc" },
        take: 12,
      });

      rawHistory.reverse();

      let formattedHistory = rawHistory.map((m) => ({
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

          // Loop de funções corrigido: Se ele chama uma função, nós DEVOLVEMOS o resultado
          // e OBRIGAMOS a IA a gerar uma resposta em texto.
          while (call) {
            console.log(`[${requestId}] 🛠️ IA usou: ${call.name}`);
            const args: any = call.args;
            let functionResult = "";

            if (call.name === "get_available_spaces") {
              functionResult = await this.getAvailableSpaces(
                nightclubId,
                args.date,
                requestId,
              );
            } else if (call.name === "create_reservation") {
              functionResult = await this.createReservationAndPayment(
                nightclubId,
                nightclub,
                args,
                requestId,
                customerPhone, // <-- Passando o número para disparar a imagem
              );
            }

            // Manda o resultado da função de volta pra IA
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

            // Se ela não chamou outra função, pegamos o texto final que ela gerou
            if (!call) {
              finalResponseText = chatResponse.text();
            }
          }

          // Salva no banco as mensagens
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

  private async getAvailableSpaces(
    nightclubId: string,
    dateStr: string,
    requestId: string,
  ) {
    try {
      const date = startOfDay(new Date(dateStr));
      const allSpaces = await prisma.space.findMany({
        where: { nightclubId, status: "ACTIVE" },
      });
      const occupiedReservations = await prisma.reservation.findMany({
        where: { nightclubId, date, status: { in: ["CONFIRMED", "PENDING"] } },
        select: { spaceId: true },
      });
      const occupiedIds = occupiedReservations.map((r) => r.spaceId);
      const available = allSpaces.filter((s) => !occupiedIds.includes(s.id));

      if (available.length === 0)
        return "Nenhum setor disponível para esta data.";
      return (
        "Disponíveis para esta data: " +
        available.map((s) => `${s.name} (R$${s.price})`).join(", ")
      );
    } catch (error) {
      return "Erro ao ler a data. Peça ao cliente para fornecer a data exata.";
    }
  }

  private async createReservationAndPayment(
    nightclubId: string,
    nightclub: any,
    args: any,
    requestId: string,
    customerPhone: string,
  ) {
    console.log(`[${requestId}] 📝 Criando reserva para ${args.customerName}`);
    try {
      const date = startOfDay(new Date(args.date));
      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
          status: "ACTIVE",
        },
      });
      if (!space)
        return "Erro: Setor inexistente. Verifique os setores disponíveis.";

      const customer = await prisma.customer.upsert({
        where: { email: args.customerEmail },
        update: { phone: args.customerPhone, name: args.customerName },
        create: {
          name: args.customerName,
          phone: args.customerPhone,
          email: args.customerEmail,
        },
      });

      const defaultDeadline = new Date(new Date().getTime() + 20 * 60000);
      const reservation = await prisma.reservation.create({
        data: {
          nightclubId,
          spaceId: space.id,
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
          customerEmail: customer.email,
          date,
          amount: space.price,
          status: "PENDING",
          paymentDeadline: defaultDeadline,
        },
      });

      const pixResponse = await axios.post(
        `${this.MAIN_API_URL}/payments/generate-pix`,
        {
          reservationId: reservation.id,
          nightclubId: nightclubId,
        },
        { headers: { "x-internal-key": this.MAIN_API_TOKEN } },
      );

      const pixCode = pixResponse.data.pixCode;
      const base64Image = pixResponse.data.qrCodeBase64;
      const checkoutLink = `https://reservasclub.com/checkout/${reservation.id}`;

      // 📸 Dispara a imagem do QR Code direto no WhatsApp
      if (base64Image) {
        try {
          // Busca o nome da instância ativa
          const instance = await prisma.whatsappInstance.findFirst({
            where: { nightclubId, status: { in: ["CONNECTED", "OPEN"] } },
            orderBy: { createdAt: "desc" },
          });

          if (instance) {
            console.log(
              `[${requestId}] 📸 Disparando Imagem do QR Code PIX para ${customerPhone}`,
            );
            await enviarMediaWhatsApp(
              instance.instanceName,
              customerPhone,
              base64Image,
              "Seu QR Code para pagamento",
            );
          }
        } catch (mediaError: any) {
          console.error(
            `[${requestId}] ⚠️ Erro ao enviar imagem do QR Code:`,
            mediaError.message,
          );
        }
      }

      // Retorna para a IA o texto que ela deve falar
      return `RESERVA CRIADA COM SUCESSO!
      
1. Código PIX Copia e Cola: ${pixCode}
2. Link do Checkout (para acompanhar ou pagar com cartão): ${checkoutLink}

Diga ao cliente que a imagem do QR Code já foi enviada acima. Repasse o Copia e Cola e o Link do Checkout.`;
    } catch (e: any) {
      console.error(`[${requestId}] 💥 Erro na criação: ${e.message}`);
      return "Erro no processo de PIX. Peça para o cliente aguardar.";
    }
  }

  private buildSystemContext(nightclub: any) {
    const customPrompt =
      nightclub?.aiAgent?.systemPrompt ||
      "Você é um assistente virtual prestativo.";

    const dataDeHoje = format(new Date(), "dd/MM/yyyy");

    return `IDENTIDADE DO AGENTE:
${customPrompt}

-------------------
REGRAS OBRIGATÓRIAS (NÃO QUEBRE SOB HIPÓTESE ALGUMA):
1. Você representa EXCLUSIVAMENTE a balada: ${nightclub.name}.
2. NUNCA diga que você é um "modelo de linguagem", "IA" ou "treinado pelo Google". Aja como humano 100% do tempo.
3. HOJE É DIA: ${dataDeHoje}. Se o cliente disser "hoje", "amanhã", etc., use esta data como base matemática.
4. Você NÃO sabe os setores disponíveis de cor. SEMPRE use a função 'get_available_spaces' para verificar a disponibilidade.
5. APÓS usar 'get_available_spaces', VOCÊ DEVE RESPONDER O CLIENTE listando as opções que encontrou.
6. Nas funções, envie as datas sempre no formato AAAA-MM-DD.
7. Quando o cliente escolher o setor, use 'create_reservation'. Exija nome, email, telefone e o setor desejado ANTES de chamar a função.
8. APÓS usar 'create_reservation', entregue a resposta informando que o QR Code foi enviado em imagem, mostre o código "Copia e Cola" e envie o Link do Checkout.`;
  }
}
