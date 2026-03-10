import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { addDays, isAfter, isBefore, startOfDay, format } from "date-fns";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error(
        "❌ [GeminiService]: Variável GEMINI_API_KEY não encontrada no Render!",
      );
    }
    this.genAI = new GoogleGenerativeAI(apiKey || "");
  }

  private tools = [
    {
      functionDeclarations: [
        {
          name: "create_reservation",
          description:
            "Cria uma nova reserva validando disponibilidade e regras da casa.",
          parameters: {
            type: "object",
            properties: {
              customerName: {
                type: "string",
                description: "Nome completo do cliente",
              },
              customerPhone: {
                type: "string",
                description: "Telefone (apenas números)",
              },
              customerEmail: {
                type: "string",
                description: "E-mail (opcional)",
              },
              date: {
                type: "string",
                description: "Data da reserva (YYYY-MM-DD)",
              },
              spaceName: {
                type: "string",
                description: "Nome do setor (ex: Camarote 1)",
              },
            },
            required: ["customerName", "customerPhone", "date", "spaceName"],
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
      // 1. Busca dados da balada na API Principal
      console.log(
        `[GeminiService] Consultando Main API em: ${this.MAIN_API_URL}/nightclubs/${nightclubId}`,
      );

      const responseMain = await axios
        .get(`${this.MAIN_API_URL}/nightclubs/${nightclubId}`)
        .catch((err) => {
          // Se der 401 aqui, você precisa verificar se a Main API exige Token!
          throw new Error(
            `Falha na Main API (${err.response?.status || "OFFLINE"}): ${err.message}`,
          );
        });

      const nightclub = responseMain.data;

      if (!nightclub || !nightclub.aiAgent?.isActive) {
        console.warn(`[GeminiService] Balada ${nightclubId} sem agente ativo.`);
        return null;
      }

      const model = this.genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        tools: this.tools as any,
      });

      const chat = model.startChat({
        history: [
          {
            role: "user",
            parts: [{ text: this.buildSystemContext(nightclub) }],
          },
          {
            role: "model",
            parts: [
              {
                text: "Assistente ReservasClub ativo. Validação de banco sincronizada.",
              },
            ],
          },
        ],
      });

      const result = await chat.sendMessage(message);
      const chatResponse = result.response;
      const call = chatResponse.functionCalls()?.[0];

      if (call && call.name === "create_reservation") {
        const args: any = call.args;
        console.log(
          `[GeminiService] IA disparando ferramenta de reserva:`,
          args,
        );

        const reservationResult = await this.validateAndCreate(
          nightclubId,
          nightclub,
          args,
        );

        const finalResponse = await chat.sendMessage([
          {
            functionResponse: {
              name: "create_reservation",
              response: { content: reservationResult },
            },
          },
        ]);

        return finalResponse.response.text();
      }

      return chatResponse.text();
    } catch (error: any) {
      // Diferenciamos o erro para você saber onde agir
      if (error.message.includes("Main API")) {
        console.error(
          "❌ [GeminiService - B.O na API Principal]:",
          error.message,
        );
      } else if (error.message.includes("API key")) {
        console.error(
          "❌ [GeminiService - B.O no Google]: Sua GEMINI_API_KEY é inválida.",
        );
      } else {
        console.error("❌ [GeminiService Error]:", error.message);
      }
      return null; // Retorna null para o controller não tentar mandar lixo pro WhatsApp
    }
  }

  private async validateAndCreate(
    nightclubId: string,
    nightclub: any,
    args: any,
  ) {
    try {
      const requestedDate = startOfDay(new Date(args.date));
      const today = startOfDay(new Date());

      const settings = nightclub.settings || {};
      const maxDays = settings.reservationLeadTimeDays || 30;
      const limitDate = addDays(today, maxDays);

      if (isBefore(requestedDate, today))
        return "Erro: Não aceitamos reservas para datas passadas.";
      if (isAfter(requestedDate, limitDate))
        return `Erro: Só aceitamos reservas com até ${maxDays} dias de antecedência.`;

      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
          status: "ACTIVE",
        },
      });

      if (!space) return `Erro: O setor '${args.spaceName}' não existe.`;

      const existing = await prisma.reservation.findFirst({
        where: {
          spaceId: space.id,
          date: requestedDate,
          status: { in: ["CONFIRMED", "PENDING"] },
        },
      });

      if (existing) return `Erro: O ${space.name} já está ocupado nesta data.`;

      const customer = await prisma.customer.upsert({
        where: {
          email:
            args.customerEmail || `user-${args.customerPhone}@reservas.com`,
        },
        update: { phone: args.customerPhone, name: args.customerName },
        create: {
          name: args.customerName,
          phone: args.customerPhone,
          email:
            args.customerEmail || `user-${args.customerPhone}@reservas.com`,
        },
      });

      const reservation = await prisma.reservation.create({
        data: {
          nightclubId,
          spaceId: space.id,
          customerId: customer.id,
          customerName: args.customerName,
          customerPhone: args.customerPhone,
          customerEmail: customer.email,
          date: requestedDate,
          amount: space.price,
          status: "PENDING",
        },
      });

      return `Sucesso! Reserva #${reservation.id.substring(0, 5)} criada para ${args.customerName}.`;
    } catch (error: any) {
      return `Erro sistêmico: ${error.message}`;
    }
  }

  private buildSystemContext(nightclub: any) {
    const spaces = (nightclub.spaces || [])
      .map((s: any) => `- ${s.name}: R$ ${s.price}`)
      .join("\n");

    return `
      VOCÊ É O ASSISTENTE DA ${nightclub.name.toUpperCase()}.
      HOJE É: ${format(new Date(), "yyyy-MM-dd")}.
      SETORES:
      ${spaces}
      REGRAS: Use 'create_reservation' apenas com Nome, Telefone, Data e Setor.
      PERSONALIDADE: ${nightclub.aiAgent?.systemPrompt || "Atendente prestativa"}
    `;
  }
}
