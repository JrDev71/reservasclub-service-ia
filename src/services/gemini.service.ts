import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { addDays, isAfter, isBefore, startOfDay, format } from "date-fns";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";
  private readonly MAIN_API_TOKEN = process.env.MAIN_API_TOKEN;

  // 🧠 MEMÓRIA DE CURTO PRAZO: Guarda o histórico da conversa por telefone do cliente
  private memoryCache = new Map<
    string,
    { role: string; parts: { text: string }[] }[]
  >();

  // 🛡️ CASCATA DE MODELOS (FALLBACK): Se um falhar, tenta o próximo na mesma fração de segundo
  private fallbackModels = [
    "gemini-flash-latest",
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-1.5-flash",
  ];

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("❌ [GeminiService]: GEMINI_API_KEY não encontrada!");
    }
    this.genAI = new GoogleGenerativeAI(apiKey || "");
  }

  private tools = [
    {
      functionDeclarations: [
        {
          name: "create_reservation",
          description:
            "Cria uma nova reserva para o cliente e retorna as instruções de pagamento PIX.",
          parameters: {
            type: "object",
            properties: {
              customerName: {
                type: "string",
                description: "Nome completo do cliente",
              },
              customerPhone: {
                type: "string",
                description: "Telefone do cliente (apenas números)",
              },
              customerEmail: {
                type: "string",
                description: "E-mail válido do cliente",
              },
              date: {
                type: "string",
                description: "Data da reserva no formato YYYY-MM-DD",
              },
              spaceName: {
                type: "string",
                description: "Nome do setor desejado",
              },
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
        {
          name: "cancel_reservation",
          description:
            "Cancela uma reserva existente pelo telefone do cliente e data.",
          parameters: {
            type: "object",
            properties: {
              customerPhone: {
                type: "string",
                description: "Telefone do cliente (apenas números)",
              },
              date: {
                type: "string",
                description: "Data da reserva a ser cancelada (YYYY-MM-DD)",
              },
            },
            required: ["customerPhone", "date"],
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
    try {
      const responseMain = await axios.get(
        `${this.MAIN_API_URL}/nightclubs/service-ia/${nightclubId}`,
        {
          headers: { "x-internal-key": this.MAIN_API_TOKEN },
        },
      );

      const nightclub = responseMain.data;
      if (!nightclub || !nightclub.aiAgent?.isActive) return null;

      // Recupera ou cria a memória do cliente
      const sessionKey = `${nightclubId}-${customerPhone}`;
      if (!this.memoryCache.has(sessionKey)) {
        this.memoryCache.set(sessionKey, []);
      }
      const userHistory = this.memoryCache.get(sessionKey)!;

      // Monta o contexto base + memória
      const baseHistory = [
        { role: "user", parts: [{ text: this.buildSystemContext(nightclub) }] },
        {
          role: "model",
          parts: [
            {
              text: "Compreendido. Estou pronto para ajudar e tenho acesso ao banco de dados.",
            },
          ],
        },
        ...userHistory,
      ];

      // 🛡️ SISTEMA DE BLINDAGEM (Retry loop nos modelos)
      for (const modelName of this.fallbackModels) {
        try {
          const model = this.genAI.getGenerativeModel({
            model: modelName,
            tools: this.tools as any,
          });
          const chat = model.startChat({ history: baseHistory });

          const result = await chat.sendMessage(message);
          const chatResponse = result.response;
          const call = chatResponse.functionCalls()?.[0];

          let finalResponseText = chatResponse.text();

          // Se a IA decidiu usar uma ferramenta
          if (call) {
            const args: any = call.args;
            let functionResult = "";

            if (call.name === "create_reservation") {
              console.log(
                `[GeminiService - ${modelName}] IA criando reserva:`,
                args,
              );
              functionResult = await this.validateAndCreate(
                nightclubId,
                nightclub,
                args,
              );
            } else if (call.name === "cancel_reservation") {
              console.log(
                `[GeminiService - ${modelName}] IA cancelando reserva:`,
                args,
              );
              functionResult = await this.cancelReservation(nightclubId, args);
            }

            const funcResponse = await chat.sendMessage([
              {
                functionResponse: {
                  name: call.name,
                  response: { content: functionResult },
                },
              },
            ]);
            finalResponseText = funcResponse.response.text();
          }

          // Salva na memória o que o cliente disse e o que a IA respondeu
          userHistory.push({ role: "user", parts: [{ text: message }] });
          userHistory.push({
            role: "model",
            parts: [{ text: finalResponseText }],
          });

          // Mantém a memória curta para não estourar tokens (últimas 10 mensagens)
          if (userHistory.length > 10) userHistory.splice(0, 2);

          return finalResponseText;
        } catch (error: any) {
          // Se for erro de cota ou sobrecarga, tenta o próximo modelo
          if (
            error.message.includes("429") ||
            error.message.includes("503") ||
            error.message.includes("404")
          ) {
            console.warn(
              `⚠️ [Blindagem] Falha no modelo ${modelName}. Tentando o próximo da fila...`,
            );
            continue;
          }
          throw error; // Se for um erro bizarro, lança a exceção e sai do loop
        }
      }

      // Se o loop terminar e TODOS os modelos falharem
      return "Nosso sistema está com uma fila de atendimento grande no momento. Poderia me mandar um 'Oi' novamente em 1 minuto?";
    } catch (error: any) {
      console.error("❌ [GeminiService Error]:", error.message);
      return null;
    }
  }

  // ... [validateAndCreate e cancelReservation permanecem iguais à última versão] ...
  private async validateAndCreate(
    nightclubId: string,
    nightclub: any,
    args: any,
  ) {
    try {
      const requestedDate = startOfDay(new Date(args.date));
      const today = startOfDay(new Date());
      const maxDays = nightclub.settings?.reservationLeadTimeDays || 30;

      if (isBefore(requestedDate, today)) return "Falha: Data no passado.";
      if (isAfter(requestedDate, addDays(today, maxDays)))
        return `Falha: O limite de antecedência é ${maxDays} dias.`;

      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
          status: "ACTIVE",
        },
      });
      if (!space)
        return `Falha: Setor '${args.spaceName}' inexistente ou inativo.`;

      const existing = await prisma.reservation.findFirst({
        where: {
          spaceId: space.id,
          date: requestedDate,
          status: { in: ["CONFIRMED", "PENDING"] },
        },
      });
      if (existing)
        return `Falha: O ${space.name} já está reservado nesta data.`;

      const customer = await prisma.customer.upsert({
        where: { email: args.customerEmail },
        update: { phone: args.customerPhone, name: args.customerName },
        create: {
          name: args.customerName,
          phone: args.customerPhone,
          email: args.customerEmail,
        },
      });

      const reservation = await prisma.reservation.create({
        data: {
          nightclubId,
          spaceId: space.id,
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
          customerEmail: customer.email,
          date: requestedDate,
          amount: space.price,
          status: "PENDING",
        },
      });

      return `SUCESSO! Reserva #${reservation.id.substring(0, 5)} criada. VALOR: R$ ${space.price}. INSTRUÇÃO PARA A IA: Diga que a reserva está pré-aprovada e que o PIX será enviado em breve.`;
    } catch (error: any) {
      return `Erro no banco: ${error.message}`;
    }
  }

  private async cancelReservation(nightclubId: string, args: any) {
    try {
      const targetDate = startOfDay(new Date(args.date));
      const reservation = await prisma.reservation.findFirst({
        where: {
          nightclubId,
          customerPhone: args.customerPhone,
          date: targetDate,
          status: { in: ["PENDING", "CONFIRMED"] },
        },
      });
      if (!reservation) return "Falha: Nenhuma reserva ativa encontrada.";

      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { status: "CANCELED" },
      });
      return "Sucesso! Reserva cancelada.";
    } catch (error: any) {
      return `Erro ao cancelar: ${error.message}`;
    }
  }

  private buildSystemContext(nightclub: any) {
    const spaces = (nightclub.spaces || [])
      .map((s: any) => `- ${s.name}: R$ ${s.price}`)
      .join("\n");
    return `
      VOCÊ É O AGENTE DE ATENDIMENTO DA ${nightclub.name.toUpperCase()}.
      HOJE É: ${format(new Date(), "yyyy-MM-dd")}.
      SETORES DISPONÍVEIS E PREÇOS:
      ${spaces}
      REGRAS:
      1. Para criar reserva, COLETE: Nome, Telefone, EMAIL e Setor.
      2. Use APENAS *asteriscos* para negrito. Sem #.
      COMPORTAMENTO:
      ${nightclub.aiAgent?.systemPrompt || "Seja eficiente."}
    `;
  }
}
