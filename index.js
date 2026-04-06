const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "50mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

const GRUPO_NF = "120363428406889529@g.us";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let sessoes = {};

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notas (
      id BIGINT PRIMARY KEY,
      fornecedor TEXT,
      numero_nf TEXT,
      data_faturamento TEXT,
      vencimento TEXT,
      valor NUMERIC,
      valor_pago NUMERIC DEFAULT 0,
      obra TEXT,
      forma_pagamento TEXT,
      chave_pix TEXT,
      pago TEXT DEFAULT 'false',
      data_pagamento TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("Banco de dados inicializado ✅");
}

async function salvarNota(n) {
  await pool.query(`
    INSERT INTO notas (id, fornecedor, numero_nf, data_faturamento, vencimento, valor, valor_pago, obra, forma_pagamento, chave_pix, pago, data_pagamento)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET
      fornecedor=EXCLUDED.fornecedor, numero_nf=EXCLUDED.numero_nf,
      data_faturamento=EXCLUDED.data_faturamento, vencimento=EXCLUDED.vencimento,
      valor=EXCLUDED.valor, valor_pago=EXCLUDED.valor_pago, obra=EXCLUDED.obra,
      forma_pagamento=EXCLUDED.forma_pagamento, chave_pix=EXCLUDED.chave_pix,
      pago=EXCLUDED.pago, data_pagamento=EXCLUDED.data_pagamento
  `, [n.id, n.fornecedor, n.numeroNF, n.dataFaturamento, n.vencimento, n.valor, n.valorPago||0, n.obra, n.formaPagamento, n.chavePix, String(n.pago), n.dataPagamento]);
}

async function buscarNotas() {
  const res = await pool.query("SELECT * FROM notas ORDER BY criado_em ASC");
  return res.rows.map(r => ({
    id: Number(r.id),
    fornecedor: r.fornecedor,
    numeroNF: r.numero_nf,
    dataFaturamento: r.data_faturamento,
    vencimento: r.vencimento,
    valor: Number(r.valor),
    valorPago: Number(r.valor_pago),
    obra: r.obra,
    formaPagamento: r.forma_pagamento,
    chavePix: r.chave_pix,
    pago: r.pago === "true" ? true : r.pago === "false" ? false : r.pago,
    dataPagamento: r.data_pagamento,
  }));
}

async function buscarNota(id) {
  const res = await pool.query("SELECT * FROM notas WHERE id=$1", [id]);
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: Number(r.id),
    fornecedor: r.fornecedor,
    numeroNF: r.numero_nf,
    dataFaturamento: r.data_faturamento,
    vencimento: r.vencimento,
    valor: Number(r.valor),
    valorPago: Number(r.valor_pago),
    obra: r.obra,
    formaPagamento: r.forma_pagamento,
    chavePix: r.chave_pix,
    pago: r.pago === "true" ? true : r.pago === "false" ? false : r.pago,
    dataPagamento: r.data_pagamento,
  };
}

async function enviarMensagem(numero, mensagem) {
  try {
    await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      { number: numero, text: mensagem },
      { headers: { apikey: EVOLUTION_API_KEY, "Content-Type": "application/json" } }
    );
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
Extraia os dados e retorne APENAS um JSON válido, sem explicações, sem markdown.
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
  const valorTotal = Number(n.valor || 0);
  const valorPago = Number(n.valorPago || 0);
  const saldo = valorTotal - valorPago;
  let statusStr = "";
  if (n.pago === "total") statusStr = `✅ Pago totalmente em ${n.dataPagamento}`;
  else if (n.pago === "parcial") statusStr = `⚡ Parcial — Pago: R$ ${valorPago.toFixed(2)} | Saldo: R$ ${saldo.toFixed(2)} | Vence: ${n.vencimento}`;
  else statusStr = "⏳ Pendente";
  let resumo = `✅ *NF salva no banco de dados!*\n\n`;
  resumo += `🏢 *Fornecedor:* ${n.fornecedor}\n`;
  resumo += `🔢 *NF Nº:* ${n.numeroNF || "N/A"}\n`;
  resumo += `📅 *Faturamento:* ${n.dataFaturamento || "N/A"}\n`;
  resumo += `⏰ *Vencimento:* ${n.vencimento || "N/A"}\n`;
  resumo += `💰 *Valor Total:* R$ ${valorTotal.toFixed(2)}\n`;
  resumo += `🏗️ *Obra/CC:* ${n.obra || "N/A"}\n`;
  resumo += `💳 *Pagamento:* ${n.formaPagamento || "N/A"}\n`;
  if (n.formaPagamento === "PIX" && n.chavePix) resumo += `🔑 *Chave PIX:* ${n.chavePix}\n`;
  resumo += `📌 *Status:* ${statusStr}`;
  return resumo;
}

async function iniciarPerguntas(grupo, nota) {
  if (!nota.obra) {
    sessoes[grupo] = { etapa: "obra", notaId: nota.id };
    await enviarMensagem(grupo, `🏗️ *Qual a Obra / Centro de Custo desta NF?*\n\nEx: Residencial Aurora, Administração, Galpão Norte...`);
    return;
  }
  if (!nota.vencimento) {
    sessoes[grupo] = { etapa: "vencimento", notaId: nota.id };
    await enviarMensagem(grupo, `📅 *Qual o vencimento desta NF?*\n\nEx: 15/04/2026`);
    return;
  }
  if (!nota.formaPagamento) {
    sessoes[grupo] = { etapa: "formaPagamento", notaId: nota.id };
    await enviarMensagem(grupo, `💳 *Qual a forma de pagamento?*\n\n1️⃣ PIX\n2️⃣ Boleto\n3️⃣ Depósito`);
    return;
  }
  if (nota.formaPagamento === "PIX" && !nota.chavePix) {
    sessoes[grupo] = { etapa: "chavePix", notaId: nota.id };
    await enviarMensagem(grupo, `🔑 *Qual a chave PIX do fornecedor ${nota.fornecedor}?*\n\nEx: CPF, CNPJ, e-mail ou chave aleatória`);
    return;
  }
  if (!nota.pago || nota.pago === false || nota.pago === "false") {
    sessoes[grupo] = { etapa: "status", notaId: nota.id };
    await enviarMensagem(grupo, `💰 *Esta NF de R$ ${Number(nota.valor).toFixed(2)} já foi paga?*\n\n1️⃣ Sim, totalmente\n2️⃣ Parcialmente\n3️⃣ Não, está pendente`);
    return;
  }
  await salvarNota(nota);
  await enviarMensagem(grupo, gerarResumoNF(nota));
}

async function processarResposta(grupo, texto) {
  const sessao = sessoes[grupo];
  if (!sessao) return false;
  const nota = await buscarNota(sessao.notaId);
  if (!nota) { delete sessoes[grupo]; return false; }
  const t = texto.trim();

  if (sessao.etapa === "obra") {
    nota.obra = t;
    delete sessoes[grupo];
    await salvarNota(nota);
    await enviarMensagem(grupo, `✅ Obra/CC: *${t}*`);
    await iniciarPerguntas(grupo, nota);
    return true;
  }

  if (sessao.etapa === "vencimento" || sessao.etapa === "novoVencimento") {
    const dataRegex = /\d{2}\/\d{2}\/\d{4}/;
    if (dataRegex.test(t)) {
      nota.vencimento = t;
      await salvarNota(nota);
      delete sessoes[grupo];
      if (sessao.etapa === "novoVencimento") {
        await enviarMensagem(grupo, gerarResumoNF(nota));
      } else {
        await enviarMensagem(grupo, `✅ Vencimento: *${t}*`);
        await iniciarPerguntas(grupo, nota);
      }
    } else {
      await enviarMensagem(grupo, `❌ Formato inválido. Use DD/MM/AAAA\nEx: 15/04/2026`);
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
      await salvarNota(nota);
      delete sessoes[grupo];
      await enviarMensagem(grupo, `✅ Forma de pagamento: *${forma}*`);
      await iniciarPerguntas(grupo, nota);
    } else {
      await enviarMensagem(grupo, `❌ Digite 1 (PIX), 2 (Boleto) ou 3 (Depósito)`);
    }
    return true;
  }

  if (sessao.etapa === "chavePix") {
    nota.chavePix = t;
    await salvarNota(nota);
    delete sessoes[grupo];
    await enviarMensagem(grupo, `✅ Chave PIX salva: *${t}*`);
    await iniciarPerguntas(grupo, nota);
    return true;
  }

  if (sessao.etapa === "status") {
    if (t === "1" || t.toLowerCase().includes("total") || t.toLowerCase() === "sim") {
      nota.pago = "total";
      nota.valorPago = nota.valor;
      nota.dataPagamento = new Date().toLocaleDateString("pt-BR");
      await salvarNota(nota);
      delete sessoes[grupo];
      await enviarMensagem(grupo, gerarResumoNF(nota));
    } else if (t === "2" || t.toLowerCase().includes("parcial")) {
      sessoes[grupo] = { etapa: "valorParcial", notaId: nota.id };
      await enviarMensagem(grupo, `💵 *Qual valor já foi pago?*\n\nValor total: R$ ${Number(nota.valor).toFixed(2)}\n\nEx: 5000`);
    } else {
      nota.pago = false;
      nota.valorPago = 0;
      await salvarNota(nota);
      delete sessoes[grupo];
      await enviarMensagem(grupo, gerarResumoNF(nota));
    }
    return true;
  }

  if (sessao.etapa === "valorParcial" || sessao.etapa === "valorParcialAtualizar") {
    const valor = parseFloat(t.replace(",", ".").replace(/[^0-9.]/g, ""));
    if (!isNaN(valor) && valor > 0) {
      nota.pago = "parcial";
      nota.valorPago = (Number(nota.valorPago || 0) + valor);
      nota.dataPagamento = new Date().toLocaleDateString("pt-BR");
      await salvarNota(nota);
      const saldo = Number(nota.valor) - Number(nota.valorPago);
      await enviarMensagem(grupo, `✅ Pago: R$ ${valor.toFixed(2)} | Saldo: R$ ${saldo.toFixed(2)}`);
      sessoes[grupo] = { etapa: "novoVencimento", notaId: nota.id };
      await enviarMensagem(grupo, `📅 *Qual a nova data de vencimento para o saldo de R$ ${saldo.toFixed(2)}?*\n\nEx: 30/04/2026`);
    } else {
      await enviarMensagem(grupo, `❌ Valor inválido. Ex: 5000 ou 5000.50`);
    }
    return true;
  }

  if (sessao.etapa === "confirmarPagamento") {
    const valor = parseFloat(t.replace(",", ".").replace(/[^0-9.]/g, ""));
    if (!isNaN(valor) && valor > 0) {
      const valorTotal = Number(nota.valor);
      const novoPago = Number(nota.valorPago || 0) + valor;
      if (novoPago >= valorTotal) {
        nota.pago = "total";
        nota.valorPago = valorTotal;
        nota.dataPagamento = new Date().toLocaleDateString("pt-BR");
        await salvarNota(nota);
        delete sessoes[grupo];
        await enviarMensagem(grupo, `✅ *${nota.fornecedor}* — Pagamento total confirmado!\n💰 R$ ${valorTotal.toFixed(2)}`);
      } else {
        nota.pago = "parcial";
        nota.valorPago = novoPago;
        nota.dataPagamento = new Date().toLocaleDateString("pt-BR");
        await salvarNota(nota);
        const saldo = valorTotal - novoPago;
        await enviarMensagem(grupo, `⚡ Pago: R$ ${novoPago.toFixed(2)} | Saldo: R$ ${saldo.toFixed(2)}`);
        sessoes[grupo] = { etapa: "novoVencimento", notaId: nota.id };
        await enviarMensagem(grupo, `📅 *Qual a nova data de vencimento para o saldo de R$ ${saldo.toFixed(2)}?*\n\nEx: 30/04/2026`);
      }
    } else {
      await enviarMensagem(grupo, `❌ Valor inválido. Ex: 5000 ou 5000.50`);
    }
    return true;
  }

  return false;
}

async function processarMidia(grupo, key, message, tipo) {
  await enviarMensagem(grupo, tipo === "pdf" ? "📄 PDF recebido! Analisando NF..." : "📸 Imagem recebida! Analisando NF...");
  const base64 = await downloadMidia(key, message);
  if (!base64) { await enviarMensagem(grupo, "❌ Não consegui baixar o arquivo. Tente novamente."); return; }
  const dados = tipo === "pdf" ? await extrairDadosNF("", null, base64) : await extrairDadosNF("", base64, null);
  if (dados && dados.fornecedor) {
    dados.id = Date.now();
    dados.pago = false;
    dados.valorPago = 0;
    dados.obra = null;
    await salvarNota(dados);
    await enviarMensagem(grupo, `📋 *NF identificada:*\n\n🏢 ${dados.fornecedor}\n💰 R$ ${Number(dados.valor || 0).toFixed(2)}\n📅 ${dados.dataFaturamento || "N/A"}`);
    await iniciarPerguntas(grupo, dados);
  } else {
    await enviarMensagem(grupo, "❌ Não consegui extrair os dados. Tente enviar o PDF ou foto mais nítida.");
  }
}

async function gerarRelatorio() {
  const notas = await buscarNotas();
  const hoje = new Date();
  const ativas = notas.filter((n) => n.pago !== "total");
  if (ativas.length === 0) return "✅ Nenhum pagamento pendente.";

  const vencidos = ativas.filter((n) => {
    if (!n.vencimento) return false;
    const [d, m, a] = n.vencimento.split("/");
    return new Date(`${a}-${m}-${d}`) < hoje;
  });

  const proximos = ativas.filter((n) => {
    if (!n.vencimento) return false;
    const [d, m, a] = n.vencimento.split("/");
    const diff = Math.ceil((new Date(`${a}-${m}-${d}`) - hoje) / 86400000);
    return diff >= 0 && diff <= 7;
  });

  let rel = `📊 *RELATÓRIO DE VENCIMENTOS*\n\n`;
  if (vencidos.length > 0) {
    rel += `🔴 *VENCIDOS (${vencidos.length}):*\n`;
    vencidos.forEach((n) => {
      const saldo = Number(n.valor) - Number(n.valorPago || 0);
      rel += `• ${n.fornecedor} - R$ ${saldo.toFixed(2)} - Venceu ${n.vencimento}\n`;
    });
    rel += "\n";
  }
  if (proximos.length > 0) {
    rel += `🟡 *PRÓXIMOS 7 DIAS (${proximos.length}):*\n`;
    proximos.forEach((n) => {
      const [d, m, a] = n.vencimento.split("/");
      const diff = Math.ceil((new Date(`${a}-${m}-${d}`) - hoje) / 86400000);
      const saldo = Number(n.valor) - Number(n.valorPago || 0);
      rel += `• ${n.fornecedor} - R$ ${saldo.toFixed(2)} - Vence em ${diff}d (${n.vencimento})\n`;
    });
    rel += "\n";
  }
  const total = ativas.reduce((s, n) => s + (Number(n.valor) - Number(n.valorPago || 0)), 0);
  rel += `💰 *Total a pagar: R$ ${total.toFixed(2)}*`;
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
    if (remoteJid !== GRUPO_NF) return;
    if (key?.fromMe) return;

    const texto = msg.conversation || msg.extendedTextMessage?.text || "";
    const textoLower = texto.toLowerCase().trim();

    if (msg.documentMessage?.mimetype?.includes("pdf")) { await processarMidia(GRUPO_NF, key, msg, "pdf"); return; }
    if (msg.imageMessage) { await processarMidia(GRUPO_NF, key, msg, "imagem"); return; }

    if (sessoes[GRUPO_NF]) {
      const processado = await processarResposta(GRUPO_NF, texto);
      if (processado) return;
    }

    if (textoLower === "ajuda" || textoLower === "menu") {
      await enviarMensagem(GRUPO_NF, `🏗️ *AGENTE CONSTRUTORA*\n\n📋 *Comandos:*\n\n• Envie *PDF* ou *foto* da NF\n• *relatorio* - ver vencimentos\n• *pago [fornecedor]* - confirmar pagamento total\n• *parcial [fornecedor]* - registrar pagamento parcial\n• *listar* - ver todas as NFs\n• *ajuda* - este menu`);
      return;
    }

    if (textoLower === "relatorio" || textoLower === "relatório") {
      await enviarMensagem(GRUPO_NF, await gerarRelatorio());
      return;
    }

    if (textoLower === "listar") {
      const notas = await buscarNotas();
      if (notas.length === 0) { await enviarMensagem(GRUPO_NF, "📋 Nenhuma nota lançada ainda."); return; }
      let lista = `📋 *NOTAS FISCAIS (${notas.length})*\n\n`;
      notas.slice(-10).forEach((n, i) => {
        const saldo = Number(n.valor) - Number(n.valorPago || 0);
        let status = "⏳ Pendente";
        if (n.pago === "total") status = "✅ Pago";
        else if (n.pago === "parcial") status = `⚡ Parcial (saldo R$ ${saldo.toFixed(2)})`;
        lista += `${i + 1}. *${n.fornecedor}*\n   R$ ${Number(n.valor).toFixed(2)} | ${n.vencimento || "S/V"} | ${status}\n\n`;
      });
      await enviarMensagem(GRUPO_NF, lista);
      return;
    }

    if (textoLower.startsWith("pago ")) {
      const nome = texto.substring(5).toLowerCase();
      const notas = await buscarNotas();
      const nota = notas.find((n) => n.fornecedor?.toLowerCase().includes(nome) && n.pago !== "total");
      if (nota) {
        sessoes[GRUPO_NF] = { etapa: "confirmarPagamento", notaId: nota.id };
        const saldo = Number(nota.valor) - Number(nota.valorPago || 0);
        await enviarMensagem(GRUPO_NF, `💵 *Quanto foi pago para ${nota.fornecedor}?*\n\nSaldo pendente: R$ ${saldo.toFixed(2)}\n\nDigite o valor:`);
      } else {
        await enviarMensagem(GRUPO_NF, `❌ Fornecedor não encontrado ou já pago.\nDigite: *pago [nome do fornecedor]*`);
      }
      return;
    }

    if (textoLower.startsWith("parcial ")) {
      const nome = texto.substring(8).toLowerCase();
      const notas = await buscarNotas();
      const nota = notas.find((n) => n.fornecedor?.toLowerCase().includes(nome) && n.pago !== "total");
      if (nota) {
        sessoes[GRUPO_NF] = { etapa: "valorParcialAtualizar", notaId: nota.id };
        const saldo = Number(nota.valor) - Number(nota.valorPago || 0);
        await enviarMensagem(GRUPO_NF, `💵 *Quanto foi pago para ${nota.fornecedor}?*\n\nSaldo pendente: R$ ${saldo.toFixed(2)}\n\nDigite o valor pago:`);
      } else {
        await enviarMensagem(GRUPO_NF, `❌ Fornecedor não encontrado.\nDigite: *parcial [nome do fornecedor]*`);
      }
      return;
    }

  } catch (err) {
    console.error("Erro geral:", err.message);
  }
});

app.get("/", (req, res) => res.json({ status: "Agente Construtora online ✅" }));

initDB().then(() => {
  app.listen(PORT, () => console.log(`Agente rodando na porta ${PORT}`));
});
