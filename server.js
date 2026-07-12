import express from "express";
import cors from "cors";
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "leituras.json");
const isVercel = Boolean(process.env.VERCEL);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

async function readStore() {
  if (isVercel) {
    globalThis.__interpretacaoStore ??= { nextId: 1, leituras: [] };
    return globalThis.__interpretacaoStore;
  }
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { nextId: 1, leituras: [] };
  }
}

async function writeStore(store) {
  if (isVercel) {
    globalThis.__interpretacaoStore = store;
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}

function cleanText(value, fallback = "") {
  return (value ?? fallback).toString().trim();
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function resolveTextProfile(idade, requestedSize) {
  const requested = cleanText(requestedSize).toLowerCase();
  const explicitSize = ["curto", "medio", "longo"].includes(requested) ? requested : "";
  const resolvedSize = explicitSize || (idade <= 8 ? "curto" : "medio");
  const complexity = idade <= 8
    ? "frases curtas, vocabulario familiar e uma sequencia simples de acontecimentos"
    : idade <= 11
      ? "paragrafos curtos, vocabulario cotidiano e uma inferencia leve"
      : "paragrafos organizados, vocabulario um pouco mais rico e inferencias moderadas";
  return {
    requested: explicitSize || "automatico",
    resolved: resolvedSize,
    complexity
  };
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const parts = [];
  for (const item of data?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === "output_text" && content?.text) parts.push(content.text);
      if (content?.type === "text" && content?.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeForMatch(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function evidenceInText(evidence, texto) {
  const normalizedEvidence = normalizeForMatch(evidence);
  if (normalizedEvidence.length < 8) return false;
  return normalizeForMatch(texto).includes(normalizedEvidence);
}

function normalizeQuestion(question, texto) {
  const type = question?.type === "mcq" ? "mcq" : "open";
  const prompt = cleanText(question?.prompt);
  const evidence = cleanText(question?.evidence);
  if (!prompt || !evidenceInText(evidence, texto)) return null;

  const normalized = {
    type,
    prompt,
    evidence,
    tags: Array.isArray(question?.tags) ? question.tags.map(String) : []
  };

  if (type === "mcq") {
    const options = Array.isArray(question?.options)
      ? question.options.map((option) => cleanText(option)).filter(Boolean).slice(0, 4)
      : [];
    const answerKey = cleanText(question?.answer_key);
    if (options.length !== 4 || !options.includes(answerKey)) return null;
    normalized.options = options;
    normalized.answer_key = answerKey;
  }

  return normalized;
}

async function askOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) return "";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: prompt
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI HTTP ${response.status}`);
  }
  return extractOutputText(data);
}

function fallbackText({ idade, tema, tamanho }) {
  const assunto = tema || "amizade e escola";
  const extra = tamanho === "longo"
    ? " No fim do dia, eles perceberam que conversar com calma ajudava a encontrar solucoes melhores."
    : "";
  return `Na turma de uma crianca de ${idade} anos, surgiu uma atividade sobre ${assunto}. No comeco, alguns alunos ficaram inseguros, porque cada pessoa tinha uma ideia diferente. A professora pediu que todos escutassem com atencao antes de responder. Aos poucos, o grupo percebeu que entender o texto era como montar um caminho: primeiro observar os fatos, depois pensar no que estava escondido nas entrelinhas. Quando chegou a vez de explicar, a crianca usou exemplos do texto e conseguiu defender sua opiniao com mais seguranca.${extra}`;
}

function fallbackQuestions(texto) {
  const baseTags = ["segura", "baseada-no-texto"];
  return [
    {
      type: "open",
      prompt: "Qual é o assunto principal do texto? Responda usando uma informação que aparece na leitura.",
      tags: baseTags
    },
    {
      type: "open",
      prompt: "Cite uma parte do texto que ajudou você a entender a história.",
      tags: baseTags
    },
    {
      type: "open",
      prompt: "O que você entendeu sobre a atitude ou a descoberta mais importante do texto?",
      tags: baseTags
    },
    {
      type: "open",
      prompt: "Se você fosse contar esse texto para alguém, qual detalhe não poderia faltar?",
      tags: baseTags
    }
  ];
}

async function generateText(params) {
  const profile = params.textProfile || resolveTextProfile(params.idade, params.tamanho);
  const prompt = `
Crie um texto curto em portugues do Brasil para uma atividade de interpretacao.
Nome do aluno, apenas para adaptar linguagem e faixa etaria, sem usar como personagem nesta atividade: ${params.aluno}
Idade: ${params.idade}
Tema: ${params.tema || "livre"}
Tamanho aplicado: ${profile.resolved}
Complexidade aplicada: ${profile.complexity}

Regras pedagogicas:
- Nao use o nome do aluno como personagem do texto nesta atividade.
- Varie personagens, lugares e situacoes de uma atividade para outra.
- Mantenha vocabulario adequado para a idade e fatos claros para gerar perguntas literais.
- Tamanho pedido pelo adulto ou sistema: ${profile.requested}.
- Se o tamanho pedido foi automatico, priorize conforto e clareza em vez de alongar demais o texto.

Responda apenas com o texto, sem titulo e sem markdown.
`.trim();

  const generated = await askOpenAI(prompt).catch((error) => {
    console.warn("OpenAI indisponivel em /api/leitura/start:", error.message);
    return "";
  });
  return generated || fallbackText({ ...params, tamanho: profile.resolved });
}

async function generateQuestions(texto) {
  const prompt = `
Crie 4 perguntas de interpretacao para o texto abaixo.
Regra obrigatoria: cada pergunta deve usar apenas fatos que aparecem literalmente no texto.
Nao invente personagem, animal, cor, lugar, objeto, sentimento, acao ou sequencia que nao esteja no texto.
Antes de responder, confira se cada pergunta pode ser respondida lendo somente o texto.
Para cada pergunta, inclua "evidence" com uma frase curta copiada exatamente do texto que prova que a pergunta esta correta.
Nas perguntas de multipla escolha, "answer_key" deve ser exatamente igual a uma das opcoes.
Retorne somente JSON valido neste formato:
{"questions":[{"type":"mcq","prompt":"...","options":["A","B","C","D"],"answer_key":"A","evidence":"frase copiada do texto","tags":["literal"]},{"type":"open","prompt":"...","evidence":"frase copiada do texto","tags":["inferencia"]}]}

Texto:
${texto}
`.trim();

  const generated = await askOpenAI(prompt).catch((error) => {
    console.warn("OpenAI indisponivel em /api/leitura/finish-reading:", error.message);
    return "";
  });
  const parsed = parseJsonLoose(generated);
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : fallbackQuestions(texto);
  const normalized = questions.map((q) => normalizeQuestion(q, texto)).filter(Boolean);
  const safeQuestions = normalized.length >= 3 ? normalized : fallbackQuestions(texto);
  return safeQuestions.slice(0, 5);
}

function computeMetrics(leitura) {
  const respostas = Array.isArray(leitura.respostas) ? leitura.respostas : [];
  const mcq = respostas.filter((r) => r.correta !== null && r.correta !== undefined);
  const mcqScore = mcq.filter((r) => r.correta === true || r.correta === 1).length;
  const totalTempo = respostas.reduce((sum, r) => sum + (Number(r.tempo_ms) || 0), 0);
  const avgQ = respostas.length ? Math.round(totalTempo / respostas.length) : null;
  return {
    read_ms: leitura.read_time_ms ?? null,
    avg_q_ms: avgQ,
    avg_q_time_ms: avgQ,
    mcq_score: mcqScore,
    mcq_max: mcq.length,
    mcq_accuracy_pct: mcq.length ? Math.round((mcqScore / mcq.length) * 100) : null
  };
}

function leituraFromRequest(body = {}) {
  return {
    id: Number(body.leitura_id) || 0,
    aluno: cleanText(body.aluno, "Aluno") || "Aluno",
    idade: clampNumber(body.idade, 11, 6, 18),
    texto: cleanText(body.texto),
    read_time_ms: Number(body.read_time_ms) || null,
    questions: Array.isArray(body.questions) ? body.questions : [],
    respostas: Array.isArray(body.respostas) ? body.respostas : [],
    feedback: ""
  };
}

async function generateFeedback(leitura) {
  const metrics = computeMetrics(leitura);
  const respostas = (leitura.respostas || [])
    .map((r) => `Pergunta ${r.pergunta_index}: ${r.pergunta}\nResposta: ${r.resposta}`)
    .join("\n\n");
  const prompt = `
Crie um feedback curto, gentil e especifico para uma crianca sobre esta atividade de interpretacao.
Use portugues do Brasil e fale diretamente com a crianca.

Estrutura desejada:
1. Comece reconhecendo o esforco ou uma atitude positiva.
2. Cite uma coisa concreta que a crianca fez bem, usando pistas das respostas.
3. Diga apenas um proximo passo pratico para melhorar na proxima leitura.

Regras de cuidado:
- Nao use tom de bronca.
- Nao use diagnosticos, rotulos ou comparacoes com outras criancas.
- Nao diga que a crianca foi mal.
- Nao transforme a pontuacao em nota; use a pontuacao apenas como apoio interno.
- Se houver poucos dados, diga que foi uma boa tentativa e convide a procurar pistas no texto com calma.

Texto: ${leitura.texto}
Respostas:
${respostas}
Pontuacao objetiva: ${metrics.mcq_score}/${metrics.mcq_max}
Responda sem markdown, em ate 5 frases.
`.trim();

  const generated = await askOpenAI(prompt).catch((error) => {
    console.warn("OpenAI indisponivel em /api/leitura/finish:", error.message);
    return "";
  });
  return generated || "Bom trabalho! Voce concluiu a leitura e respondeu com atencao. Na proxima tentativa, procure voltar ao texto e apontar a parte que ajudou na resposta. Assim, cada resposta fica mais segura e mais facil de explicar.";
}

app.get(["/", "/index.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api", (_req, res) => {
  res.type("text/plain; charset=utf-8").send("OK - Interpretacao de Texto backend rodando");
});

app.post("/api/leitura/start", async (req, res) => {
  try {
    const aluno = cleanText(req.body?.aluno, "Miguel") || "Miguel";
    const idade = clampNumber(req.body?.idade, 11, 6, 18);
    const tema = cleanText(req.body?.tema);
    const tamanhoPedido = cleanText(req.body?.tamanho);
    const textProfile = resolveTextProfile(idade, tamanhoPedido);
    const tamanho = textProfile.resolved;
    const texto = await generateText({ aluno, idade, tema, tamanho, textProfile });

    const store = await readStore();
    const leitura = {
      id: store.nextId++,
      aluno,
      idade,
      tema,
      tamanho,
      tamanho_pedido: textProfile.requested,
      complexidade: textProfile.complexity,
      titulo: "Interpretacao de texto",
      texto,
      created_at: new Date().toISOString(),
      read_time_ms: null,
      questions: [],
      respostas: [],
      feedback: ""
    };
    store.leituras.push(leitura);
    await writeStore(store);
    res.json({
      leitura_id: leitura.id,
      texto,
      config: {
        idade,
        tema,
        tamanho,
        tamanho_pedido: textProfile.requested,
        complexidade: textProfile.complexity
      }
    });
  } catch (error) {
    res.status(500).json({ error: "Erro ao preparar atividade", details: error.message });
  }
});

app.post("/api/leitura/finish-reading", async (req, res) => {
  try {
    const leituraId = Number(req.body?.leitura_id);
    const store = await readStore();
    let leitura = store.leituras.find((item) => item.id === leituraId);
    if (!leitura && req.body?.texto) {
      leitura = leituraFromRequest(req.body);
    }
    if (!leitura) return res.status(404).json({ error: "Sessao nao encontrada" });

    leitura.read_time_ms = Number(req.body?.read_time_ms) || null;
    leitura.questions = await generateQuestions(leitura.texto);
    if (store.leituras.some((item) => item.id === leituraId)) await writeStore(store);
    res.json({ questions: leitura.questions });
  } catch (error) {
    res.status(500).json({ error: "Erro ao gerar perguntas", details: error.message });
  }
});

app.post("/api/leitura/answer", async (req, res) => {
  const leituraId = Number(req.body?.leitura_id);
  const store = await readStore();
  const leitura = store.leituras.find((item) => item.id === leituraId);
  if (!leitura) return res.json({ ok: true, stored: false });

  leitura.respostas.push({
    pergunta_index: Number(req.body?.pergunta_index) || null,
    pergunta: cleanText(req.body?.pergunta),
    resposta: cleanText(req.body?.resposta),
    correta: req.body?.correta ?? null,
    tempo_ms: Number(req.body?.tempo_ms) || null,
    tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : []
  });
  await writeStore(store);
  res.json({ ok: true });
});

app.post("/api/leitura/finish", async (req, res) => {
  try {
    const leituraId = Number(req.body?.leitura_id);
    const store = await readStore();
    let leitura = store.leituras.find((item) => item.id === leituraId);
    if (!leitura && req.body?.texto) {
      leitura = leituraFromRequest(req.body);
    }
    if (!leitura) return res.status(404).json({ error: "Sessao nao encontrada" });

    leitura.feedback = await generateFeedback(leitura);
    if (store.leituras.some((item) => item.id === leituraId)) await writeStore(store);
    res.json({ feedback: leitura.feedback, metrics: computeMetrics(leitura) });
  } catch (error) {
    res.status(500).json({ error: "Erro ao gerar feedback", details: error.message });
  }
});

app.get("/api/leitura/resumo", async (req, res) => {
  const aluno = cleanText(req.query?.aluno, "Miguel") || "Miguel";
  const idade = clampNumber(req.query?.idade, 11, 6, 18);
  const limit = clampNumber(req.query?.limit, 30, 1, 200);
  const store = await readStore();
  const sessoes = store.leituras
    .filter((item) => item.aluno === aluno && Number(item.idade) === idade)
    .slice(-limit)
    .reverse()
    .map((item) => ({
      id: item.id,
      created_at: item.created_at,
      read_time_ms: item.read_time_ms,
      total_questions: item.questions?.length ?? 0,
      feedback: item.feedback,
      ...computeMetrics(item)
    }));
  res.json({ aluno, idade, sessoes });
});

app.get("/api/leitura/detalhe", async (req, res) => {
  const leituraId = Number(req.query?.id);
  const store = await readStore();
  const leitura = store.leituras.find((item) => item.id === leituraId);
  if (!leitura) return res.status(404).json({ error: "Sessao nao encontrada" });
  res.json({
    leitura,
    respostas: leitura.respostas || [],
    metrics: computeMetrics(leitura)
  });
});

if (!isVercel) {
  const PORT = Number(process.env.PORT || 3001);
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

export default app;
