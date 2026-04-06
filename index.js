const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "50mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const PORT = process.env.PORT || 3000;

let notas = [];
let sessoes = {};

async function enviarMensagem(numero, mensagem) {
  try {
    await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      { number: numero, text: mensagem },
      { headers: { apikey: EVOLUTION_API_KEY, "Content-Type": "application/json" } }
    );
    console.log("Mensagem enviada para", numero);
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err.response?.data || err.message);
  }
}

async function downloadMidia(key, message) {
  try {
    const response = await axios.post(
      `${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`,
      { message: { key, message } },
      { headers: { apikey: EVOLUTION_API_KEY } }
    );
    return response.data?.base64 || null;
  } catch (err) {
    console.error("Erro ao baixar mídia:", err.response?.data || err.message);
    return null;
  }
}

async function extrairDadosNF(texto = "", imagemBase64 = null, pdfBase64 = null) {
  try {
    const content = [];
    if (imagemBase64) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imagemBase64 } });
    if (pdfBase64) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } });
    content.push({
      type: "text",
      text: `Você é um assistente especializado em notas fiscais brasileiras.
Extraia os dados da nota fiscal e retorne APENAS um JSON válido, sem explicações, sem markdown.
${texto ? "Texto: " + texto : ""}
Formato:
{"fornecedor":"nome","dataFaturamento":"DD/MM/AAAA","vencimento":"DD/MM/AAAA","valor":0.00,"formaPagamento":"PIX ou Boleto ou Deposito","numeroNF":"numero"}
Se não encontrar algum campo, use null.`,
    });

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content }] },
      { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );

    const resposta = response.data.content[0].text;
    const match = resposta.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return null;
  } catch (err) {
    console.error("Erro IA:", err.response?.data || err.message);
    return null;
  }
}

function gerarResumoNF(n) {
  return `✅ *NF lançada com sucesso!*\n\n🏢 *Fornecedor:* ${n.fornecedor}\n🔢 *NF Nº:* ${n.numeroNF || "N/A"}\n📅 *Faturamento:* ${n.dataFaturamento || "N/A"}\n⏰ *Vencimento:* ${n.vencimento || "N/A"}\n💰 *Valor:* R$ ${Number(n.valor || 0).toFixed(2)}\n🏗️ *Obra/CC:* ${n.obra || "N/A"}\n💳 *Pagamento:* ${n.formaPagamento || "N/A"}\n📌 *Status:* ${n.pago ? "✅ Pago em " + n.dataPagamento : "⏳ Pendente"}`;
}

async function iniciarPerguntas(numero, nota) {
  // SEMPRE pergunta obra primeiro
  if (!nota.obra) {
    sessoes[numero] = { etapa: "obra", notaId: nota.id };
    await enviarMensagem(numero, `🏗️ *Qual a Obra / Centro de Custo desta NF?*\n\nEx: Residencial Aurora, Administração, Galpão Norte...`);
    return;
  }
  if (!nota.vencimento) {
    sessoes[numero] = { etapa: "vencimento", notaId: nota.id };
    await enviarMensagem(numero, `📅 *Qual o vencimento desta NF?*\n\nEx: 15/04/2026`);
    return;
  }
  if (!nota.formaPagamento) {
    sessoes[numero] = { etapa: "formaPagamento", notaId: nota.id };
    await enviarMensagem(numero, `💳 *Qual a forma de pagamento?*\n\n1️⃣ PIX\n2️⃣ Boleto\n3️⃣ Depósito`);
    return;
  }
  sessoes[numero] = { etapa: "status", notaId: nota.id };
  await enviarMensagem(numero, `💰 *Esta NF já foi paga?*\n\n1️⃣ Sim, já paguei\n2️⃣ Não, está pendente`);
}

async function processarResposta(numero, texto) {
  const sessao = sessoes[numero];
  if (!sessao) return false;

  const nota = notas.find((n) => n.id === sessao.notaId);
  if (!nota) { delete sessoes[numero]; return false; }

  const t = texto.trim();

  if (sessao.etapa === "obra") {
    nota.obra = t;
    delete sessoes[numero];
    await enviarMensagem(numero, `✅ Obra/CC: *${t}*`);
    await iniciarPerguntas(numero, nota);
    return true;
  }

  if (sessao.etapa === "vencimento") {
    const dataRegex = /\d{2}\/\d{2}\/\d{4}/;
    if (dataRegex.test(t)) {
      nota.vencimento = t;
      delete sessoes[numero];
      await enviarMensagem(numero, `✅ Vencimento: *${t}*`);
      await iniciarPerguntas(numero, nota);
    } else {
      await enviarMensagem(numero, `❌ Formato inválido. Use DD/MM/AAAA\nEx: 15/04/2026`);
    }
    return true;
  }

  if (sessao.etapa === "formaPagamento") {
    let forma = null;
    if (t === "1" || t.toLowerCase().includes("pix")) forma = "PIX";
    else if (t === "2" || t.toLowerCase().includes("boleto")) forma = "Boleto";
    else if (t === "3" || t.toLowerCase().includes("dep")) forma = "Depósito";

    if (forma) {
      nota.formaPagamento = forma;
      delete sessoes[numero];
      await enviarMensagem(numero, `✅ Forma de pagamento: *${forma}*`);
      await iniciarPerguntas(numero, nota);
    } else {
      await enviarMensagem(numero, `❌ Digite 1 (PIX), 2 (Boleto) ou 3 (Depósito)`);
    }
    return true;
  }

  if (sessao.etapa === "status") {
    if (t === "1" || t.toLowerCase().includes("sim") || t.toLowerCase().includes("pag")) {
      nota.pago = true;
      nota.dataPagamento = new Date().toLocaleDateString("pt-BR");
      delete sessoes[numero];
      await enviarMensagem(numero, gerarResumoNF(nota));
    } else {
      nota.pago = false;
      delete sessoes[numero];
      await enviarMensagem(numero, gerarResumoNF(nota));
    }
    return true;
  }

  return false;
}

async function processarMidia(numero, key, message, tipo) {
  await enviarMensagem(numero, tipo === "pdf" ? "📄 PDF recebido! Analisando NF..." : "📸 Imagem recebida! Analisando NF...");

  const base64 = await downloadMidia(key, message);
  if (!base64) { await enviarMensagem(numero, "❌ Não consegui baixar o arquivo. Tente novamente."); return; }

  const dados = tipo === "pdf"
    ? await extrairDadosNF("", null, base64)
    : await extrairDadosNF("", base64, null);

  if (dados && dados.fornecedor) {
    dados.id = Date.now();
    dados.pago = false;
    dados.obra = null; // Sempre pede a obra
    notas.push(dados);
    await enviarMensagem(numero, `📋 *NF identificada:*\n\n🏢 ${dados.fornecedor}\n💰 R$ ${Number(dados.valor || 0).toFixed(2)}\n📅 ${dados.dataFaturamento || "N/A"}`);
    await iniciarPerguntas(numero, dados);
  } else {
    await enviarMensagem(numero, "❌ Não consegui extrair os dados. Tente enviar o PDF ou uma foto mais nítida.");
  }
}

function gerarRelatorio() {
  const hoje = new Date();
  const pendentes = notas.filter((n) => !n.pago);
  if (pendentes.length === 0) return "✅ Nenhum pagamento pendente.";

  const vencidos = pendentes.filter((n) => {
    if (!n.vencimento) return false;
    const [d, m, a] = n.vencimento.split("/");
    return new Date(`${a}-${m}-${d}`) < hoje;
  });

  const proximos = pendentes.filter((n) => {
    if (!n.vencimento) return false;
    const [d, m, a] = n.vencimento.split("/");
    const diff = Math.ceil((new Date(`${a}-${m}-${d}`) - hoje) / 86400000);
    return diff >= 0 && diff <= 7;
  });

  let rel = `📊 *RELATÓRIO DE VENCIMENTOS*\n\n`;
  if (vencidos.length > 0) {
    rel += `🔴 *VENCIDOS (${vencidos.length}):*\n`;
    vencidos.forEach((n) => rel += `• ${n.fornecedor} - R$ ${Number(n.valor).toFixed(2)} - Venceu ${n.vencimento}\n`);
    rel += "\n";
  }
  if (proximos.length > 0) {
    rel += `🟡 *PRÓXIMOS 7 DIAS (${proximos.length}):*\n`;
    proximos.forEach((n) => {
      const [d, m, a] = n.vencimento.split("/");
      const diff = Math.ceil((new Date(`${a}-${m}-${d}`) - hoje) / 86400000);
      rel += `• ${n.fornecedor} - R$ ${Number(n.valor).toFixed(2)} - Vence em ${diff}d (${n.vencimento})\n`;
    });
    rel += "\n";
  }
  const total = pendentes.reduce((s, n) => s + Number(n.valor || 0), 0);
  rel += `💰 *Total pendente: R$ ${total.toFixed(2)}*`;
  return rel;
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body.data || !body.data.message) return;

    const msg = body.data.message;
    const key = body.data.key;
    const remoteJid = key?.remoteJid || "";
    const numero = remoteJid.replace("@s.whatsapp.net", "").replace("@g.us", "");
    if (!numero || key?.fromMe) return;

    const texto = msg.conversation || msg.extendedTextMessage?.text || "";
    const textoLower = texto.toLowerCase().trim();
    console.log("De:", numero, "Texto:", texto);

    if (msg.documentMessage?.mimetype?.includes("pdf")) {
      await processarMidia(numero, key, msg, "pdf");
      return;
    }

    if (msg.imageMessage) {
      await processarMidia(numero, key, msg, "imagem");
      return;
    }

    if (sessoes[numero]) {
      const processado = await processarResposta(numero, texto);
      if (processado) return;
    }

    if (textoLower === "ajuda" || textoLower === "menu") {
      await enviarMensagem(numero, `🏗️ *AGENTE CONSTRUTORA*\n\n📋 *Comandos:*\n\n• Envie *PDF* ou *foto* da NF\n• *relatorio* - ver vencimentos\n• *pago [fornecedor]* - confirmar pagamento\n• *listar* - ver todas as NFs\n• *ajuda* - este menu`);
      return;
    }

    if (textoLower === "relatorio" || textoLower === "relatório") {
      await enviarMensagem(numero, gerarRelatorio());
      return;
    }

    if (textoLower === "listar") {
      if (notas.length === 0) { await enviarMensagem(numero, "📋 Nenhuma nota lançada ainda."); return; }
      let lista = `📋 *NOTAS FISCAIS (${notas.length})*\n\n`;
      notas.slice(-10).forEach((n, i) => {
        lista += `${i + 1}. *${n.fornecedor}*\n   R$ ${Number(n.valor).toFixed(2)} | ${n.vencimento || "S/V"} | ${n.pago ? "✅ Pago" : "⏳ Pendente"}\n\n`;
      });
      await enviarMensagem(numero, lista);
      return;
    }

    if (textoLower.startsWith("pago ")) {
      const nome = texto.substring(5).toLowerCase();
      const nota = notas.find((n) => n.fornecedor?.toLowerCase().includes(nome) && !n.pago);
      if (nota) {
        nota.pago = true;
        nota.dataPagamento = new Date().toLocaleDateString("pt-BR");
        await enviarMensagem(numero, `✅ Pagamento de *${nota.fornecedor}* - R$ ${Number(nota.valor).toFixed(2)} confirmado!`);
      } else {
        await enviarMensagem(numero, `❌ Fornecedor não encontrado.\nDigite: *pago [nome do fornecedor]*`);
      }
      return;
    }

  } catch (err) {
    console.error("Erro geral:", err.message);
  }
});

app.get("/", (req, res) => res.json({ status: "Agente Construtora online ✅", notas: notas.length }));

app.listen(PORT, () => console.log(`Agente rodando na porta ${PORT}`));
