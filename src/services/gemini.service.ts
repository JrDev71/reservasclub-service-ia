import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { addDays, isAfter, isBefore, startOfDay, format } from "date-fns";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";
  private readonly MAIN_API_TOKEN = process.env.MAIN_API_TOKEN;

  // 🛡️ LISTA DE BLINDAGEM COMPLETA
  private fallbackModels = [
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-2.0-flash-lite",
    "gemini-flash-latest",
    "gemini-1.5-flash",
    "gemini-pro-latest",
  ];

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    this.genAI = new GoogleGenerativeAI(apiKey || "");
  }

  private tools = [
    {
      functionDeclarations: [
        {
          name: "get_available_spaces",
          description:
            "Consulta quais setores (camarotes, bistrôs) estão disponíveis para uma data específica.",
          parameters: {
            type: "object",
            properties: {
              date: {
                type: "string",
                description: "Data da consulta (YYYY-MM-DD)",
              },
            },
            required: ["date"],
          },
        },
        {
          name: "create_reservation",
          description:
            "Cria a reserva no sistema e gera o pagamento PIX para o cliente.",
          parameters: {
            type: "object",
            properties: {
              customerName: { type: "string", description: "Nome completo" },
              customerPhone: {
                type: "string",
                description: "Telefone com DDD",
              },
              customerEmail: {
                type: "string",
                description: "E-mail obrigatório",
              },
              date: { type: "string", description: "Data (YYYY-MM-DD)" },
              spaceName: {
                type: "string",
                description: "Nome do setor (ex: Camarote 1)",
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

      // 🧠 BUSCA MEMÓRIA NO BANCO DE DADOS (Últimas 12 mensagens para contexto rico)
      const chatHistory = await prisma.aiMemory.findMany({
        where: { nightclubId, customerPhone },
        orderBy: { createdAt: "asc" },
        take: 12,
      });

      // Formata para o padrão do Google SDK
      const formattedHistory = chatHistory.map((m) => ({
        role: m.role,
        parts: [{ text: m.content }],
      }));

      const baseHistory = [
        { role: "user", parts: [{ text: this.buildSystemContext(nightclub) }] },
        {
          role: "model",
          parts: [
            {
              text: "Sistema Sincronizado com Memória Persistente. Estou pronto.",
            },
          ],
        },
        ...formattedHistory,
      ];

      for (const modelName of this.fallbackModels) {
        try {
          const model = this.genAI.getGenerativeModel({
            model: modelName,
            tools: this.tools as any,
          });
          const chat = model.startChat({ history: baseHistory });

          let result = await chat.sendMessage(message);
          let chatResponse = result.response;
          let call = chatResponse.functionCalls()?.[0];

          while (call) {
            let functionResult = "";

            if (call.name === "get_available_spaces") {
              functionResult = await this.getAvailableSpaces(
                nightclubId,
                call.args.date,
              );
            } else if (call.name === "create_reservation") {
              functionResult = await this.createReservationAndPayment(
                nightclubId,
                nightclub,
                call.args,
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
          }

          const responseText = chatResponse.text();

          // 💾 SALVA NA MEMÓRIA (BANCO DE DADOS)
          await prisma.aiMemory.createMany({
            data: [
              { nightclubId, customerPhone, role: "user", content: message },
              {
                nightclubId,
                customerPhone,
                role: "model",
                content: responseText,
              },
            ],
          });

          return responseText;
        } catch (error: any) {
          console.warn(
            `⚠️ [Blindagem] Falha no ${modelName} (${error.message}). Tentando próximo...`,
          );
          continue;
        }
      }
      return "Estou com um problema técnico agora, mas já te retorno.";
    } catch (e) {
      return null;
    }
  }

  private async getAvailableSpaces(nightclubId: string, dateStr: string) {
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
      "Setores Disponíveis para " +
      dateStr +
      ":\n" +
      available.map((s) => `- ${s.name} (R$ ${s.price})`).join("\n")
    );
  }

  private async createReservationAndPayment(
    nightclubId: string,
    nightclub: any,
    args: any,
  ) {
    try {
      const date = startOfDay(new Date(args.date));
      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
          status: "ACTIVE",
        },
      });
      if (!space) return "Erro: Setor não encontrado.";

      const check = await prisma.reservation.findFirst({
        where: {
          spaceId: space.id,
          date,
          status: { in: ["CONFIRMED", "PENDING"] },
        },
      });
      if (check) return "Erro: Este setor acabou de ser ocupado.";

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
          date,
          amount: space.price,
          status: "PENDING",
        },
      });

      try {
        const pixResponse = await axios.post(
          `${this.MAIN_API_URL}/payments/generate-pix`,
          {
            reservationId: reservation.id,
            nightclubId: nightclubId,
          },
          { headers: { "x-internal-key": this.MAIN_API_TOKEN } },
        );

        return `SUCESSO! Reserva #${reservation.id.substring(0, 5)} criada. 
                COPIE O PIX PARA PAGAR:
                ${pixResponse.data.pixCode}
                
                O seu QR Code de entrada será enviado após o pagamento.`;
      } catch (err) {
        return "Reserva criada, mas o PIX falhou. Enviaremos em instantes.";
      }
    } catch (e: any) {
      return "Erro: " + e.message;
    }
  }

  private buildSystemContext(nightclub: any) {
    return `
      VOCÊ É A INTELIGÊNCIA VENDAS DA ${nightclub.name.toUpperCase()}.
      REGRAS:
      1. Use 'get_available_spaces' antes de confirmar datas.
      2. Peça SEMPRE: Nome, Telefone e E-mail.
      3. Entregue o código PIX retornado pela ferramenta.
      4. Personalidade: ${nightclub.aiAgent?.systemPrompt || "Cordial."}
    `;
  }
}
