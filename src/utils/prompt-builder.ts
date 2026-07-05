import { format } from "date-fns";

export function buildSystemContext(nightclub: any) {
  const identity =
    nightclub?.aiAgent?.promptIdentity ||
    nightclub?.aiAgent?.systemPrompt ||
    "Você é um assistente virtual prestativo.";
  const tableRules =
    nightclub?.aiAgent?.promptTable || "Consulte os valores disponíveis.";
  const birthdayRules =
    nightclub?.aiAgent?.promptBirthday ||
    "Consulte as condições de aniversário.";
  const events =
    nightclub?.aiAgent?.promptEvents || "Nenhum evento especial no momento.";

  const schedule = nightclub?.aiAgent?.promptSchedule || {};
  const mediaLinks = nightclub?.aiAgent?.mediaLinks || {};

  const dataDeHoje = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());

  // 💰 Tratamento do preço de aniversário
  const precoAniversarioRaw = nightclub?.aiAgent?.birthdayPrice;
  const precoAniversario =
    precoAniversarioRaw !== null &&
    precoAniversarioRaw !== undefined &&
    Number(precoAniversarioRaw) > 0
      ? `R$ ${Number(precoAniversarioRaw).toFixed(2).replace(".", ",")}`
      : "Grátis (sem taxa de reserva)";

  // 🚀 MAPEAMENTO DINÂMICO DE TAGS DE MÍDIA
  const dayMap: any = {
    mon: "SEGUNDA",
    tue: "TERCA",
    wed: "QUARTA",
    thu: "QUINTA",
    fri: "SEXTA",
    sat: "SABADO",
    sun: "DOMINGO",
  };

  // Aqui a gente cria a lista de tags baseada no que o dono da balada UPOU de fato
  let dynamicMediaTags = "";
  Object.keys(mediaLinks).forEach((key) => {
    if (key.endsWith("Flyer") && mediaLinks[key]) {
      const dayKey = key.replace("Flyer", ""); // extrai "mon", "tue", etc
      const dayName = dayMap[dayKey];
      if (dayName) {
        dynamicMediaTags += `- [ENVIAR_FLYER_${dayName}] : Use quando o cliente perguntar da programação de ${dayName.toLowerCase()} ou pedir o flyer desse dia.\n`;
      }
    }
  });

  // Tag de vídeo de aniversário (se houver)
  if (mediaLinks.birthdayVideo) {
    dynamicMediaTags += `- [ENVIAR_VIDEO_ANIVERSARIO] : Use ao explicar as regras de aniversário para mostrar o vídeo promocional.\n`;
  }

  // ... (mantenha o código anterior igual até a parte de regras)

  return `=== IDENTIDADE E POSTURA ===
${identity}

=== REGRAS DE MESAS ===
${tableRules}

=== REGRAS DE ANIVERSÁRIO ===
${birthdayRules}

=== PROGRAMAÇÃO DA SEMANA ===
${JSON.stringify(schedule, null, 2)}

=== EVENTOS ESPECIAIS E AVISOS ===
${events}

-------------------
⚠️ REGRAS OBRIGATÓRIAS DE ATENDIMENTO:
1. Você representa EXCLUSIVAMENTE a balada: ${nightclub.name}.
2. HOJE É DIA: ${dataDeHoje}.
3. 🛑 PRECIFICAÇÃO DE ANIVERSÁRIO: O valor base é ${precoAniversario}. Se for aniversário, ignore o valor da mesa e use este.

🚨 REGRAS ESTRITAS DE RESERVA E SISTEMA (LEIA COM ATENÇÃO):
4. Você NUNCA deve chamar a função \`get_available_spaces\` logo após chamar \`create_reservation\`.
5. Ao chamar \`create_reservation\`, assuma imediatamente que a reserva foi um SUCESSO. A mesa já está garantida no sistema e bloqueada para o cliente.
6. 🛡️ REGRA ANTI-OVERBOOKING: Se o usuário pedir "a confirmação", "o comprovante", "o voucher", "o ingresso" ou perguntar se o pagamento já caiu, você NUNCA deve usar 'create_reservation'. 
7. 🔍 CONSULTA OBRIGATÓRIA: Nesses casos de confirmação, use SEMPRE a ferramenta \`get_customer_reservations\` enviando o número de telefone do cliente para verificar o status atual no sistema. Se retornar 'CONFIRMED' ou 'PAID', apenas avise que está tudo certo e envie o link de checkout para ele acessar o ingresso.
8. Se o cliente já tem uma reserva em andamento aguardando pagamento (Pix), NÃO tente criar uma nova reserva. Mantenha o foco em orientá-lo a pagar o Pix da reserva atual.
9. É estritamente PROIBIDO criar mais de uma reserva para o mesmo cliente na mesma conversa, a menos que ele peça explicitamente.

=== 📸 ENVIO DE MÍDIAS (USO OBRIGATÓRIO DE TAGS) ===
Para enviar fotos ou vídeos, você DEVE colocar a tag EXATAMENTE como listada abaixo ao final da sua mensagem:

- [ENVIAR_MAPA] : Use quando o cliente pedir para ver o mapa ou setores.
${dynamicMediaTags}

🛑 REGRA DE SEGURANÇA: Se o cliente pedir flyer de um dia que NÃO possui uma tag [ENVIAR_FLYER_...] listada acima, responda apenas em texto informando que o flyer ainda não está disponível, mas descreva a programação.

Atenção: NÃO coloque texto depois da tag.`;
}
