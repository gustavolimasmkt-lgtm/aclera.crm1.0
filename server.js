require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cron = require('node-cron');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3001;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const LOGIN_USER = process.env.LOGIN_USER || 'admin';
const LOGIN_PASS = process.env.LOGIN_PASS || 'greencar2024';

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/icons', express.static(path.join(__dirname, 'frontend', 'icons')));

// ─── AUTH ─────────────────────────────────────────────────────────
const sessions = new Set();

app.post('/api/login', (req, res) => {
  const { usuario, senha } = req.body || {};
  if (usuario === LOGIN_USER && senha === LOGIN_PASS) {
    const token = Date.now() + '-' + Math.random().toString(36).slice(2);
    sessions.add(token);
    setTimeout(() => sessions.delete(token), 24 * 60 * 60 * 1000);
    return res.json({ ok: true, token });
  }
  res.status(401).json({ error: 'Usuário ou senha incorretos' });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(req.headers['x-session-token']);
  res.json({ ok: true });
});

// Webhook público — sem auth
app.get('/api/webhook/waspeed', (req, res) => {
  res.json({ ok: true, status: 'webhook ativo', timestamp: new Date().toISOString() });
});

// Auth middleware para todas as outras rotas /api
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  const token = req.headers['x-session-token'] || req.query.token;
  if (!sessions.has(token)) return res.status(401).json({ error: 'Não autorizado' });
  // Renova sessão
  sessions.delete(token);
  sessions.add(token);
  setTimeout(() => sessions.delete(token), 24 * 60 * 60 * 1000);
  next();
});

// ─── BANCO ────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'crm.db'));
db.pragma('journal_mode = WAL');

// Cria todas as tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL DEFAULT 'Lead',
    telefone TEXT NOT NULL DEFAULT '',
    email TEXT,
    carro_interesse TEXT,
    parcela_max REAL,
    tem_troca INTEGER DEFAULT 0,
    carro_troca TEXT,
    etiqueta TEXT DEFAULT 'geral',
    temperatura TEXT DEFAULT 'morno',
    estagio TEXT DEFAULT 'novo',
    origem TEXT DEFAULT 'Meta Ads',
    observacoes TEXT,
    conversa_historico TEXT,
    ai_score INTEGER DEFAULT 0,
    ai_insight TEXT,
    ai_sugestao TEXT,
    duplicado INTEGER DEFAULT 0,
    proximo_contato TEXT,
    ultimo_contato TEXT,
    data_nascimento TEXT,
    motivo_perda TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS tarefas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    titulo TEXT NOT NULL,
    descricao TEXT,
    tipo TEXT DEFAULT 'followup',
    data_vencimento TEXT,
    concluida INTEGER DEFAULT 0,
    concluida_em TEXT,
    criada_por_ia INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS anotacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    tipo TEXT DEFAULT 'nota',
    conteudo TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS veiculos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marca TEXT NOT NULL,
    modelo TEXT NOT NULL,
    ano TEXT,
    versao TEXT,
    cor TEXT,
    km INTEGER DEFAULT 0,
    preco REAL,
    parcela_estimada REAL,
    status TEXT DEFAULT 'disponivel',
    descricao TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS ai_relatorios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Migrations — adiciona colunas que podem não existir em bancos antigos
const migrations = [
  'ALTER TABLE leads ADD COLUMN conversa_historico TEXT',
  'ALTER TABLE leads ADD COLUMN proximo_contato TEXT',
  'ALTER TABLE leads ADD COLUMN ultimo_contato TEXT',
  'ALTER TABLE leads ADD COLUMN ai_insight TEXT',
  'ALTER TABLE leads ADD COLUMN ai_sugestao TEXT',
  'ALTER TABLE leads ADD COLUMN duplicado INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN data_nascimento TEXT',
  'ALTER TABLE leads ADD COLUMN motivo_perda TEXT',
  'ALTER TABLE leads ADD COLUMN email TEXT',
  'ALTER TABLE tarefas ADD COLUMN criada_por_ia INTEGER DEFAULT 0',
  'ALTER TABLE tarefas ADD COLUMN concluida_em TEXT',
  'ALTER TABLE tarefas ADD COLUMN descricao TEXT',
  'ALTER TABLE anotacoes ADD COLUMN tipo TEXT DEFAULT "nota"',
];
migrations.forEach(sql => { try { db.prepare(sql).run(); } catch(e) {} });
console.log('✅ Banco e migrations ok');

// Salva referência do db para o webhook
app.locals.db = db;

// ─── IA ───────────────────────────────────────────────────────────
async function claudeAI(prompt, maxTokens = 800) {
  if (!ANTHROPIC_KEY) return null;
  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    return r.data.content[0].text;
  } catch (e) {
    console.error('IA erro:', e?.response?.data?.error?.message || e.message);
    return null;
  }
}

function parseJSON(txt) {
  if (!txt) return null;
  try { return JSON.parse(txt.replace(/```json|```/g, '').trim()); } catch { return null; }
}

function getDataFollowup(urgencia, proximo_contato) {
  const hoje = new Date();
  const amanha = new Date(hoje); amanha.setDate(hoje.getDate() + 1);
  const semana = new Date(hoje); semana.setDate(hoje.getDate() + 5);
  const fmt = d => d.toISOString().split('T')[0];
  if (proximo_contato) return proximo_contato;
  const u = String(urgencia || '').toLowerCase();
  if (['alta','hoje','urgente','imediato'].includes(u)) return fmt(hoje);
  if (['media','média','amanha','amanhã','breve'].includes(u)) return fmt(amanha);
  if (['sem_urgencia','nenhuma','none'].includes(u)) return null;
  return fmt(semana);
}

// ─── IA: ANALISAR CONVERSA ────────────────────────────────────────
app.post('/api/ia/analisar-conversa', async (req, res) => {
  const { conversa, salvar_lead_id } = req.body;
  if (!conversa) return res.status(400).json({ error: 'Conversa obrigatória' });

  const hoje = new Date();
  const hojeISO = hoje.toISOString().split('T')[0];
  const hojeStr = hoje.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const amanha = new Date(hoje); amanha.setDate(hoje.getDate() + 1);
  const amanhaISO = amanha.toISOString().split('T')[0];
  const semana = new Date(hoje); semana.setDate(hoje.getDate() + 5);
  const semanaISO = semana.toISOString().split('T')[0];

  const prompt = `Você é especialista em vendas de carros usados. Analise esta conversa do WhatsApp.

HOJE: ${hojeStr} (${hojeISO}) | AMANHÃ: ${amanhaISO} | EM 5 DIAS: ${semanaISO}

REGRAS DE TEMPERATURA:
- "quente": cliente pediu proposta, preço, agendamento, financiamento — intenção clara
- "morno": interesse mas só perguntas gerais, ainda pesquisando
- "frio": sumiu, disse vai pensar, respondeu pouco

REGRAS DE URGÊNCIA:
- "hoje": precisa retorno hoje mesmo
- "amanha": lead quente que merece atenção rápida
- "essa_semana": lead morno
- "sem_urgencia": lead frio, deixa ele entrar em contato

CONVERSA:
${conversa}

Retorne APENAS JSON válido sem markdown:
{
  "nome": "nome do cliente ou null",
  "telefone": "número com DDD ou null",
  "cidade": "cidade mencionada ou null",
  "carro_interesse": "marca modelo ano ou null",
  "parcela_max": numero_ou_null,
  "tem_troca": true_ou_false,
  "carro_troca": "marca modelo ano ou null",
  "etiqueta": "Ka ou Cruze ou HB20 ou Onix ou Toro ou geral",
  "temperatura": "quente ou morno ou frio",
  "estagio": "novo ou interessado ou pediu_proposta ou em_negociacao ou sumiu",
  "objecoes": "objeções separadas por vírgula ou null",
  "tom_emocional": "animado ou hesitante ou frio ou urgente ou neutro",
  "ultimo_contato": "data YYYY-MM-DD da última mensagem do cliente",
  "proximo_contato": "data YYYY-MM-DD para próximo contato",
  "resumo": "3-4 frases completas sobre o lead",
  "proximo_passo": "ação específica a fazer agora",
  "tarefa_titulo": "título curto da tarefa de follow-up",
  "tarefa_descricao": "detalhes do que fazer",
  "urgencia_followup": "hoje ou amanha ou essa_semana ou sem_urgencia"
}`;

  const txt = await claudeAI(prompt, 1000);
  const data = parseJSON(txt);
  if (!data) return res.status(500).json({ error: 'IA não respondeu. Tente novamente.' });

  if (salvar_lead_id) {
    // Atualiza o lead com todos os dados extraídos
    const sets = ["conversa_historico=?", "updated_at=datetime('now','localtime')"];
    const vals = [conversa];

    if (data.nome)          { sets.push('nome=?');            vals.push(data.nome); }
    if (data.telefone)      { sets.push('telefone=?');         vals.push(data.telefone.replace(/\D/g,'')); }
    if (data.carro_interesse) { sets.push('carro_interesse=?'); vals.push(data.carro_interesse); }
    if (data.parcela_max)   { sets.push('parcela_max=?');      vals.push(data.parcela_max); }
    if (data.tem_troca !== undefined) { sets.push('tem_troca=?'); vals.push(data.tem_troca ? 1 : 0); }
    if (data.carro_troca)   { sets.push('carro_troca=?');      vals.push(data.carro_troca); }
    if (data.etiqueta)      { sets.push('etiqueta=?');         vals.push(data.etiqueta); }
    if (data.temperatura)   { sets.push('temperatura=?');      vals.push(data.temperatura); }
    if (data.estagio)       { sets.push('estagio=?');          vals.push(data.estagio); }
    if (data.proximo_contato) { sets.push('proximo_contato=?'); vals.push(data.proximo_contato); }
    if (data.ultimo_contato)  { sets.push('ultimo_contato=?');  vals.push(data.ultimo_contato); }
    if (data.resumo)        { sets.push('ai_insight=?');       vals.push(data.resumo); }
    if (data.proximo_passo) { sets.push('ai_sugestao=?');      vals.push(data.proximo_passo); }
    vals.push(salvar_lead_id);

    db.prepare(`UPDATE leads SET ${sets.join(',')} WHERE id=?`).run(...vals);

    // Anotação
    const anotTxt = ['🤖 Conversa analisada pela IA',
      data.resumo ? 'Resumo: ' + data.resumo : null,
      data.objecoes ? 'Objeções: ' + data.objecoes : null,
      data.cidade ? 'Cidade: ' + data.cidade : null,
    ].filter(Boolean).join(' | ');
    db.prepare('INSERT INTO anotacoes (lead_id, tipo, conteudo) VALUES (?,?,?)').run(salvar_lead_id, 'ia', anotTxt);

    // Tarefa de follow-up
    const dataVenc = getDataFollowup(data.urgencia_followup, data.proximo_contato);
    if (dataVenc && data.urgencia_followup !== 'sem_urgencia') {
      const titulo = data.tarefa_titulo || ('Follow-up — ' + (data.nome || 'Lead'));
      db.prepare('INSERT INTO tarefas (lead_id, titulo, descricao, tipo, data_vencimento, criada_por_ia) VALUES (?,?,?,?,?,1)')
        .run(salvar_lead_id, titulo, data.tarefa_descricao || data.proximo_passo || '', 'followup', dataVenc);
      data._tarefa_criada = true;
      data._tarefa_data = dataVenc;
    }
  }

  res.json(data);
});

// ─── IA: SCORE DO LEAD ────────────────────────────────────────────
app.post('/api/ia/analisar-lead/:id', async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Não encontrado' });
  const hoje = new Date().toISOString().split('T')[0];
  const dias = Math.floor((Date.now() - new Date(lead.updated_at)) / 86400000);
  const prompt = `Lead de carros. Retorne APENAS JSON sem markdown:
Nome:${lead.nome} Carro:${lead.carro_interesse||'?'} Parcela:${lead.parcela_max||'?'} Temp:${lead.temperatura} Estágio:${lead.estagio} Parado:${dias}d
{"score":0_a_10,"insight":"análise em 2 frases","sugestao":"ação concreta agora","urgencia":"alta ou media ou baixa"}`;
  const txt = await claudeAI(prompt, 200);
  const data = parseJSON(txt);
  if (!data) return res.json({ score: 0, insight: 'IA indisponível', sugestao: '', urgencia: 'baixa' });
  db.prepare('UPDATE leads SET ai_score=?, ai_insight=?, ai_sugestao=? WHERE id=?').run(data.score||0, data.insight||'', data.sugestao||'', lead.id);
  res.json(data);
});

// ─── IA: ANALISAR TODOS (score rápido) ───────────────────────────
app.post('/api/ia/analisar-todos', async (req, res) => {
  const leads = db.prepare("SELECT * FROM leads WHERE estagio NOT IN ('fechado','fechado_ganho','comprou_outro','desqualificado','perdido') LIMIT 20").all();
  res.json({ message: `Analisando ${leads.length} leads...`, total: leads.length });
  (async () => {
    const hoje = new Date().toISOString().split('T')[0];
    const amanha = new Date(); amanha.setDate(amanha.getDate()+1);
    const amanhaISO = amanha.toISOString().split('T')[0];
    const semana = new Date(); semana.setDate(semana.getDate()+5);
    const semanaISO = semana.toISOString().split('T')[0];
    for (const lead of leads) {
      const dias = Math.floor((Date.now() - new Date(lead.updated_at)) / 86400000);
      const prompt = `Lead de carros. JSON sem markdown:
Nome:${lead.nome} Carro:${lead.carro_interesse||'?'} Parcela:${lead.parcela_max||'?'} Temp:${lead.temperatura} Estágio:${lead.estagio} Parado:${dias}d
{"score":0_a_10,"insight":"1 frase","sugestao":"ação agora","urgencia":"alta/media/baixa","criar_tarefa":true_ou_false,"tarefa_titulo":"título curto ou null"}`;
      const txt = await claudeAI(prompt, 200);
      const d = parseJSON(txt);
      if (d) {
        db.prepare('UPDATE leads SET ai_score=?, ai_insight=?, ai_sugestao=? WHERE id=?').run(d.score||0, d.insight||'', d.sugestao||'', lead.id);
        // Cria tarefa se sugerido e não tem tarefa pendente
        if (d.criar_tarefa && d.tarefa_titulo) {
          const jaTemTarefa = db.prepare('SELECT id FROM tarefas WHERE lead_id=? AND concluida=0').get(lead.id);
          if (!jaTemTarefa) {
            const u = String(d.urgencia||'').toLowerCase();
            const dataVenc = u==='alta' ? amanhaISO : u==='media' ? semanaISO : semanaISO;
            db.prepare('INSERT INTO tarefas (lead_id,titulo,descricao,tipo,data_vencimento,criada_por_ia) VALUES (?,?,?,?,?,1)')
              .run(lead.id, d.tarefa_titulo, d.sugestao||'', 'followup', dataVenc);
          }
        }
      }
      await new Promise(r => setTimeout(r, 700));
    }
  })();
});

// ─── IA: LOTE (conversa → analisa e cria tarefas) ─────────────────
const loteStatus = { rodando: false, total: 0, processados: 0, erros: 0, log: [] };

app.get('/api/ia/lote/status', (req, res) => res.json(loteStatus));

app.post('/api/ia/lote/iniciar', async (req, res) => {
  if (loteStatus.rodando) return res.json({ message: 'Já rodando', status: loteStatus });
  const { modo } = req.body || {};
  // modo='todos': analisa todos os leads; modo='conversa' (padrão): só com conversa
  const query = modo === 'todos'
    ? "SELECT * FROM leads WHERE estagio NOT IN ('fechado','fechado_ganho','comprou_outro','desqualificado','perdido') LIMIT 80"
    : "SELECT * FROM leads WHERE conversa_historico IS NOT NULL AND conversa_historico != '' AND estagio NOT IN ('fechado','fechado_ganho','comprou_outro','desqualificado','perdido') LIMIT 50";
  const leads = db.prepare(query).all();
  if (!leads.length) return res.json({ message: 'Nenhum lead encontrado para analisar', total: 0 });
  loteStatus.rodando = true; loteStatus.total = leads.length; loteStatus.processados = 0; loteStatus.erros = 0; loteStatus.log = [];
  res.json({ message: `Analisando ${leads.length} leads com conversa...`, total: leads.length });

  (async () => {
    const hoje = new Date();
    const hojeISO = hoje.toISOString().split('T')[0];

    for (const lead of leads) {
      try {
        loteStatus.log.push(`🔄 ${lead.nome}...`);
        // Prompt adaptado: com conversa = analisa conversa; sem conversa = analisa dados do lead
        const temConversa = lead.conversa_historico && lead.conversa_historico.trim().length > 10;
        const prompt = temConversa
          ? `Analise esta conversa de vendas de carros. HOJE: ${hojeISO}
CONVERSA:
${lead.conversa_historico.substring(0, 2000)}
Retorne APENAS JSON sem markdown:
{"nome":"nome do cliente ou null","carro_interesse":"marca modelo ou null","parcela_max":numero_ou_null,"tem_troca":true_ou_false,"carro_troca":"ou null","etiqueta":"Ka/Cruze/HB20/Onix/Toro/geral","temperatura":"quente/morno/frio","estagio":"novo/interessado/pediu_proposta/em_negociacao/sumiu","objecoes":"ou null","ultimo_contato":"YYYY-MM-DD ou null","proximo_contato":"YYYY-MM-DD ou null","resumo":"2 frases","proximo_passo":"ação concreta","tarefa_titulo":"título curto","urgencia_followup":"hoje/amanha/essa_semana/sem_urgencia"}`
          : `Avalie este lead de vendas de carros e sugira próximos passos. HOJE: ${hojeISO}
Lead: ${lead.nome} | Carro: ${lead.carro_interesse||'não informado'} | Parcela: ${lead.parcela_max||'não informada'} | Temperatura: ${lead.temperatura} | Estágio: ${lead.estagio} | Parado há: ${Math.floor((Date.now()-new Date(lead.updated_at))/86400000)} dias
Retorne APENAS JSON sem markdown:
{"carro_interesse":"${lead.carro_interesse||''}","parcela_max":${lead.parcela_max||null},"tem_troca":${lead.tem_troca?true:false},"etiqueta":"${lead.etiqueta||'geral'}","temperatura":"quente/morno/frio","estagio":"${lead.estagio}","resumo":"avaliação em 2 frases","proximo_passo":"ação concreta agora","tarefa_titulo":"título da tarefa de follow-up","urgencia_followup":"hoje/amanha/essa_semana/sem_urgencia"}`;

        const txt = await claudeAI(prompt, 600);
        const data = parseJSON(txt);
        if (!data) { loteStatus.erros++; loteStatus.log.push(`❌ ${lead.nome}: IA não respondeu`); continue; }

        // Atualiza lead
        const sets = ["updated_at=datetime('now','localtime')"];
        const vals = [];
        if (data.nome && data.nome !== lead.nome) { sets.push('nome=?'); vals.push(data.nome); }
        if (data.carro_interesse) { sets.push('carro_interesse=?'); vals.push(data.carro_interesse); }
        if (data.parcela_max)     { sets.push('parcela_max=?');     vals.push(data.parcela_max); }
        if (data.tem_troca !== undefined) { sets.push('tem_troca=?'); vals.push(data.tem_troca ? 1 : 0); }
        if (data.carro_troca)     { sets.push('carro_troca=?');     vals.push(data.carro_troca); }
        if (data.etiqueta)        { sets.push('etiqueta=?');        vals.push(data.etiqueta); }
        if (data.temperatura)     { sets.push('temperatura=?');     vals.push(data.temperatura); }
        if (data.estagio)         { sets.push('estagio=?');         vals.push(data.estagio); }
        if (data.proximo_contato) { sets.push('proximo_contato=?'); vals.push(data.proximo_contato); }
        if (data.ultimo_contato)  { sets.push('ultimo_contato=?');  vals.push(data.ultimo_contato); }
        if (data.resumo)          { sets.push('ai_insight=?');      vals.push(data.resumo); }
        if (data.proximo_passo)   { sets.push('ai_sugestao=?');     vals.push(data.proximo_passo); }
        const score = data.temperatura === 'quente' ? 8 : data.temperatura === 'morno' ? 5 : 2;
        sets.push('ai_score=?'); vals.push(score);
        vals.push(lead.id);
        db.prepare(`UPDATE leads SET ${sets.join(',')} WHERE id=?`).run(...vals);

        // Anotação
        const anotTxt = ['🤖 Lote IA', data.resumo, data.objecoes ? 'Objeções: '+data.objecoes : null].filter(Boolean).join(' | ');
        db.prepare('INSERT INTO anotacoes (lead_id, tipo, conteudo) VALUES (?,?,?)').run(lead.id, 'ia', anotTxt);

        // Tarefa — só cria se não tiver pendente
        const jaTemTarefa = db.prepare('SELECT id FROM tarefas WHERE lead_id=? AND concluida=0').get(lead.id);
        if (!jaTemTarefa && data.urgencia_followup !== 'sem_urgencia') {
          const dataVenc = getDataFollowup(data.urgencia_followup, data.proximo_contato);
          if (dataVenc) {
            const titulo = data.tarefa_titulo || ('Follow-up — ' + lead.nome);
            db.prepare('INSERT INTO tarefas (lead_id, titulo, descricao, tipo, data_vencimento, criada_por_ia) VALUES (?,?,?,?,?,1)')
              .run(lead.id, titulo, data.proximo_passo || '', 'followup', dataVenc);
            loteStatus.log.push(`✅ ${lead.nome}: ${data.temperatura} | 📋 ${titulo} (${dataVenc})`);
          } else {
            loteStatus.log.push(`✅ ${lead.nome}: ${data.temperatura} | sem urgência`);
          }
        } else {
          loteStatus.log.push(`✅ ${lead.nome}: ${data.temperatura} | tarefa já existe`);
        }
        loteStatus.processados++;
        if (loteStatus.log.length > 100) loteStatus.log = loteStatus.log.slice(-80);
      } catch(e) {
        loteStatus.erros++;
        loteStatus.log.push(`❌ ${lead.nome}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 800));
    }
    loteStatus.rodando = false;
    loteStatus.log.push(`🎉 Concluído! ${loteStatus.processados}/${loteStatus.total} analisados. ${loteStatus.erros} erros.`);
    console.log('✅ Lote concluído:', loteStatus.processados, 'leads');
  })();
});

// ─── IA: RELATÓRIO ────────────────────────────────────────────────
async function gerarRelatorio() {
  if (!ANTHROPIC_KEY) return;
  const total = db.prepare('SELECT COUNT(*) as n FROM leads').get().n || 0;
  const quentes = db.prepare("SELECT COUNT(*) as n FROM leads WHERE temperatura='quente'").get().n || 0;
  const fechados = db.prepare("SELECT COUNT(*) as n FROM leads WHERE estagio IN ('fechado','fechado_ganho')").get().n || 0;
  const por_etiqueta = db.prepare('SELECT etiqueta, COUNT(*) as n FROM leads GROUP BY etiqueta ORDER BY n DESC LIMIT 5').all();
  const top = db.prepare("SELECT nome,carro_interesse,ai_score FROM leads WHERE temperatura='quente' ORDER BY ai_score DESC LIMIT 5").all();
  const prompt = `Relatório diário de vendas de carros. Em português, motivador e prático.
Total:${total} Quentes:${quentes} Fechados:${fechados}
Etiquetas: ${por_etiqueta.map(e=>e.etiqueta+':'+e.n).join(',')}
Top leads: ${top.map(l=>l.nome+'('+l.carro_interesse+')'). join('; ')}
Gere: 1)RESUMO 2)3 AÇÕES PRIORITÁRIAS 3)DICA DO DIA`;
  const txt = await claudeAI(prompt, 600);
  if (txt) db.prepare('INSERT INTO ai_relatorios (tipo, conteudo) VALUES (?,?)').run('diario', txt);
}

cron.schedule('0 8 * * *', gerarRelatorio);

app.get('/api/ia/relatorio', (req, res) => {
  const r = db.prepare('SELECT * FROM ai_relatorios ORDER BY created_at DESC LIMIT 1').get();
  res.json(r || { conteudo: 'Clique em "Gerar relatório" para criar a análise do dia.' });
});

app.post('/api/ia/relatorio/gerar', async (req, res) => {
  res.json({ message: 'Gerando...' });
  await gerarRelatorio();
});

// ─── TAREFAS ──────────────────────────────────────────────────────
app.get('/api/tarefas', (req, res) => {
  const { lead_id, pendentes, vencidas } = req.query;
  let q = `SELECT t.*, l.nome as lead_nome, l.telefone as lead_telefone
    FROM tarefas t JOIN leads l ON t.lead_id=l.id WHERE 1=1`;
  const p = [];
  if (lead_id) { q += ' AND t.lead_id=?'; p.push(lead_id); }
  if (pendentes) q += ' AND t.concluida=0';
  if (vencidas)  q += " AND t.data_vencimento < date('now','localtime') AND t.concluida=0";
  q += ' ORDER BY t.concluida ASC, t.data_vencimento ASC, t.created_at DESC';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/tarefas', (req, res) => {
  const { lead_id, titulo, descricao, tipo, data_vencimento } = req.body;
  if (!lead_id || !titulo) return res.status(400).json({ error: 'lead_id e titulo obrigatórios' });
  const r = db.prepare('INSERT INTO tarefas (lead_id, titulo, descricao, tipo, data_vencimento) VALUES (?,?,?,?,?)')
    .run(lead_id, titulo, descricao||null, tipo||'followup', data_vencimento||null);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/tarefas/:id/concluir', (req, res) => {
  const t = db.prepare('SELECT * FROM tarefas WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Não encontrada' });
  db.prepare("UPDATE tarefas SET concluida=1, concluida_em=datetime('now','localtime') WHERE id=?").run(req.params.id);
  db.prepare('INSERT INTO anotacoes (lead_id, tipo, conteudo) VALUES (?,?,?)').run(t.lead_id, 'tarefa_concluida', '✅ Tarefa concluída: ' + t.titulo + (t.descricao ? ' — ' + t.descricao : ''));
  db.prepare("UPDATE leads SET updated_at=datetime('now','localtime') WHERE id=?").run(t.lead_id);
  res.json({ ok: true });
});

app.delete('/api/tarefas/:id', (req, res) => {
  db.prepare('DELETE FROM tarefas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── LEADS ────────────────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  const { temperatura, etiqueta, troca, parcela_max, estagio, busca, ordenar, data_inicio, data_fim } = req.query;
  let q = `SELECT l.*,
    CAST(julianday('now','localtime') - julianday(l.updated_at) AS INTEGER) as dias_parado,
    (SELECT COUNT(*) FROM tarefas WHERE lead_id=l.id AND concluida=0) as tarefas_pendentes,
    (SELECT COUNT(*) FROM tarefas WHERE lead_id=l.id AND concluida=0 AND data_vencimento < date('now','localtime')) as tarefas_vencidas
    FROM leads l WHERE 1=1`;
  const p = [];
  if (temperatura)  { q += ' AND l.temperatura=?';  p.push(temperatura); }
  if (etiqueta)     { q += ' AND l.etiqueta=?';     p.push(etiqueta); }
  if (estagio)      { q += ' AND l.estagio=?';      p.push(estagio); }
  if (troca==='1')  q += ' AND l.tem_troca=1';
  if (parcela_max)  { q += ' AND (l.parcela_max IS NULL OR l.parcela_max<=?)'; p.push(Number(parcela_max)); }
  if (busca)        { q += ' AND (l.nome LIKE ? OR l.carro_interesse LIKE ? OR l.telefone LIKE ?)'; p.push(`%${busca}%`,`%${busca}%`,`%${busca}%`); }
  if (data_inicio)  { q += ' AND l.created_at >= ?'; p.push(data_inicio); }
  if (data_fim)     { q += ' AND l.created_at <= ?'; p.push(data_fim + ' 23:59:59'); }
  if (ordenar==='score')  q += ' ORDER BY l.ai_score DESC, l.updated_at DESC';
  else if (ordenar==='parado') q += ' ORDER BY dias_parado DESC';
  else if (ordenar==='nome')   q += ' ORDER BY l.nome ASC';
  else if (ordenar==='recente') q += ' ORDER BY l.created_at DESC';
  else q += ' ORDER BY l.updated_at DESC';
  res.json(db.prepare(q).all(...p));
});

app.get('/api/leads/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Não encontrado' });
  lead.anotacoes = db.prepare('SELECT * FROM anotacoes WHERE lead_id=? ORDER BY created_at DESC').all(req.params.id);
  lead.tarefas = db.prepare('SELECT * FROM tarefas WHERE lead_id=? ORDER BY concluida ASC, data_vencimento ASC').all(req.params.id);
  lead.dias_parado = Math.floor((Date.now() - new Date(lead.updated_at)) / 86400000);
  res.json(lead);
});

app.post('/api/leads', (req, res) => {
  const { nome, telefone, email, carro_interesse, parcela_max, tem_troca, carro_troca, etiqueta, temperatura, estagio, origem, observacoes, conversa_historico, data_nascimento } = req.body;
  if (!nome || !telefone) return res.status(400).json({ error: 'Nome e telefone obrigatórios' });
  const tel = telefone.replace(/\D/g,'');
  const dup = db.prepare("SELECT id FROM leads WHERE replace(replace(replace(telefone,'-',''),' ',''),'(','') LIKE ?").get('%' + tel.slice(-8));
  const r = db.prepare(`INSERT INTO leads (nome,telefone,email,carro_interesse,parcela_max,tem_troca,carro_troca,etiqueta,temperatura,estagio,origem,observacoes,conversa_historico,data_nascimento,duplicado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nome, tel, email||null, carro_interesse||null, parcela_max||null, tem_troca?1:0, carro_troca||null, etiqueta||'geral', temperatura||'morno', estagio||'novo', origem||'Meta Ads', observacoes||null, conversa_historico||null, data_nascimento||null, dup?1:0);
  res.json({ id: r.lastInsertRowid, duplicado: !!dup, duplicado_id: dup?.id });
});

app.put('/api/leads/:id', (req, res) => {
  const { nome, telefone, email, carro_interesse, parcela_max, tem_troca, carro_troca, etiqueta, temperatura, estagio, origem, observacoes, conversa_historico, proximo_contato, ultimo_contato, data_nascimento, motivo_perda } = req.body;
  db.prepare(`UPDATE leads SET nome=?,telefone=?,email=?,carro_interesse=?,parcela_max=?,tem_troca=?,carro_troca=?,etiqueta=?,temperatura=?,estagio=?,origem=?,observacoes=?,conversa_historico=COALESCE(?,conversa_historico),proximo_contato=?,ultimo_contato=?,data_nascimento=?,motivo_perda=?,updated_at=datetime('now','localtime') WHERE id=?`)
    .run(nome, (telefone||'').replace(/\D/g,''), email||null, carro_interesse||null, parcela_max||null, tem_troca?1:0, carro_troca||null, etiqueta||'geral', temperatura||'morno', estagio||'novo', origem||'Meta Ads', observacoes||null, conversa_historico||null, proximo_contato||null, ultimo_contato||null, data_nascimento||null, motivo_perda||null, req.params.id);
  res.json({ ok: true });
});

app.put('/api/leads/:id/estagio', (req, res) => {
  const { estagio } = req.body;
  db.prepare("UPDATE leads SET estagio=?, updated_at=datetime('now','localtime') WHERE id=?").run(estagio, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/leads/:id', (req, res) => {
  db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/leads/:id/anotacao', (req, res) => {
  const { conteudo, tipo } = req.body;
  if (!conteudo) return res.status(400).json({ error: 'Conteúdo obrigatório' });
  db.prepare('INSERT INTO anotacoes (lead_id, tipo, conteudo) VALUES (?,?,?)').run(req.params.id, tipo||'nota', conteudo);
  db.prepare("UPDATE leads SET updated_at=datetime('now','localtime') WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/leads/:id/duplicar', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Não encontrado' });
  const r = db.prepare(`INSERT INTO leads (nome,telefone,email,carro_interesse,parcela_max,tem_troca,carro_troca,etiqueta,temperatura,estagio,origem,observacoes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(l.nome+' (cópia)', l.telefone, l.email, l.carro_interesse, l.parcela_max, l.tem_troca, l.carro_troca, l.etiqueta, 'morno', 'novo', l.origem, l.observacoes);
  res.json({ id: r.lastInsertRowid });
});

// ─── IMPORTAR LEADS ───────────────────────────────────────────────
app.post('/api/leads/importar-texto', (req, res) => {
  const { dados, origem } = req.body;
  let criados=0, duplicados=0, erros=0;
  for (const linha of (dados||'').split('\n').map(l=>l.trim()).filter(Boolean)) {
    try {
      const p = linha.split(/[,;|\t]/);
      const nome = p.length > 1 ? p[0].trim() : 'Lead importado';
      const tel = (p.length > 1 ? p[1] : p[0]).trim().replace(/\D/g,'');
      if (!tel || tel.length < 8) { erros++; continue; }
      const dup = db.prepare("SELECT id FROM leads WHERE replace(replace(telefone,'-',''),' ','') LIKE ?").get('%'+tel.slice(-8));
      if (dup) { duplicados++; continue; }
      db.prepare("INSERT INTO leads (nome,telefone,origem,etiqueta,temperatura,estagio) VALUES (?,?,?,?,?,?)").run(nome, tel, origem||'Importado', 'geral', 'morno', 'novo');
      criados++;
    } catch { erros++; }
  }
  res.json({ criados, duplicados, erros, total: criados+duplicados+erros });
});

app.post('/api/leads/importar-excel', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo obrigatório' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    fs.unlinkSync(req.file.path);
    const get = (row, keys) => {
      const rk = Object.keys(row).map(k=>k.toLowerCase().trim());
      for (const k of keys) { const i = rk.findIndex(r=>r.includes(k)); if(i>=0) return Object.values(row)[i]; }
      return '';
    };
    let criados=0, duplicados=0, erros=0;
    for (const row of rows) {
      try {
        const tel = String(get(row,['telefone','celular','whatsapp','phone'])||'').replace(/\D/g,'');
        if (!tel || tel.length < 8) { erros++; continue; }
        const dup = db.prepare("SELECT id FROM leads WHERE replace(replace(telefone,'-',''),' ','') LIKE ?").get('%'+tel.slice(-8));
        if (dup) { duplicados++; continue; }
        const nome = String(get(row,['nome','name','cliente'])||'').trim() || 'Lead importado';
        const conversa = String(get(row,['conversa','historico','mensagem','chat'])||'').trim() || null;
        db.prepare(`INSERT INTO leads (nome,telefone,email,carro_interesse,parcela_max,tem_troca,carro_troca,etiqueta,temperatura,estagio,origem,observacoes,conversa_historico,data_nascimento) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(nome, tel,
            String(get(row,['email'])||''),
            String(get(row,['carro','veiculo','interesse'])||''),
            parseFloat(String(get(row,['parcela','valor'])||'').replace(/[^0-9.]/g,''))||null,
            ['sim','yes','1','true'].includes(String(get(row,['troca'])||'').toLowerCase()) ? 1 : 0,
            String(get(row,['carro_troca'])||''),
            String(get(row,['etiqueta','categoria'])||'geral'),
            String(get(row,['temperatura','temp'])||'morno'),
            String(get(row,['estagio','fase'])||'novo'),
            String(get(row,['origem'])||req.body.origem||'Importado'),
            String(get(row,['obs','observa'])||''),
            conversa,
            String(get(row,['nascimento','aniversario','birthday'])||'')||null
          );
        criados++;
      } catch { erros++; }
    }
    res.json({ criados, duplicados, erros, total: rows.length });
  } catch(e) { res.status(400).json({ error: 'Erro ao ler arquivo: '+e.message }); }
});

// ─── EXPORTAR LEADS ───────────────────────────────────────────────
app.get('/api/leads/exportar/numeros', (req, res) => {
  const { ids } = req.query;
  const leads = ids
    ? db.prepare(`SELECT telefone FROM leads WHERE id IN (${ids.split(',').map(()=>'?').join(',')})`).all(...ids.split(',').map(Number))
    : db.prepare('SELECT telefone FROM leads').all();
  res.setHeader('Content-Type','text/plain');
  res.send(leads.map(l=>l.telefone.replace(/\D/g,'')).join('\n'));
});

app.get('/api/leads/exportar/excel', (req, res) => {
  const { ids } = req.query;
  const leads = ids
    ? db.prepare(`SELECT * FROM leads WHERE id IN (${ids.split(',').map(()=>'?').join(',')})`).all(...ids.split(',').map(Number))
    : db.prepare('SELECT * FROM leads ORDER BY updated_at DESC').all();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(leads.map(l => ({
    'Nome': l.nome, 'Telefone': l.telefone, 'Email': l.email||'',
    'Carro': l.carro_interesse||'', 'Parcela': l.parcela_max||'',
    'Troca': l.tem_troca?'Sim':'Não', 'Carro Troca': l.carro_troca||'',
    'Etiqueta': l.etiqueta||'', 'Temperatura': l.temperatura||'',
    'Estágio': l.estagio||'', 'Origem': l.origem||'',
    'Score IA': l.ai_score||0, 'Insight IA': l.ai_insight||'',
    'Próx. Contato': l.proximo_contato||'', 'Último Contato': l.ultimo_contato||'',
    'Nascimento': l.data_nascimento||'', 'Motivo Perda': l.motivo_perda||'',
    'Observações': l.observacoes||'', 'Conversa': l.conversa_historico||'',
    'Criado em': l.created_at||'', 'Atualizado em': l.updated_at||'',
  })));
  ws['!cols'] = Array(21).fill({ wch: 20 });
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="leads_${new Date().toISOString().split('T')[0]}.xlsx"`);
  res.send(buf);
});

app.get('/api/leads/template/excel', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([{
    nome:'João Silva', telefone:'48999998888', email:'joao@email.com',
    carro_interesse:'Ka 2020', parcela_max:700, tem_troca:'sim', carro_troca:'Gol 2018',
    etiqueta:'Ka', temperatura:'quente', estagio:'interessado', origem:'Meta Ads',
    observacoes:'Quer financiar 80%', conversa_historico:'[10:30] João: Oi vi o Ka...',
    data_nascimento:'1990-05-13'
  }]);
  ws['!cols'] = Array(15).fill({ wch: 20 });
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="template_leads.xlsx"');
  res.send(buf);
});

// ─── VEÍCULOS ─────────────────────────────────────────────────────
app.get('/api/veiculos', (req, res) => res.json(db.prepare('SELECT * FROM veiculos ORDER BY created_at DESC').all()));

app.post('/api/veiculos', (req, res) => {
  const { marca, modelo, ano, versao, cor, km, preco, parcela_estimada, status, descricao } = req.body;
  if (!marca || !modelo) return res.status(400).json({ error: 'Marca e modelo obrigatórios' });
  const r = db.prepare('INSERT INTO veiculos (marca,modelo,ano,versao,cor,km,preco,parcela_estimada,status,descricao) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(marca, modelo, ano||null, versao||null, cor||null, km||0, preco||null, parcela_estimada||null, status||'disponivel', descricao||null);
  const veiculoId = r.lastInsertRowid;
  const matchBasico = db.prepare("SELECT COUNT(*) as n FROM leads WHERE (LOWER(carro_interesse) LIKE ? OR LOWER(etiqueta)=LOWER(?)) AND estagio NOT IN ('fechado','fechado_ganho','comprou_outro','desqualificado','perdido') AND (parcela_max IS NULL OR parcela_max >= ?)").get('%'+modelo.toLowerCase()+'%', modelo, parcela_estimada||0).n||0;
  res.json({ id: veiculoId, matches: matchBasico, auto_match: true });
  // Dispara match IA em background automaticamente
  if (ANTHROPIC_KEY) {
    setTimeout(async () => {
      try {
        const veiculo = db.prepare('SELECT * FROM veiculos WHERE id=?').get(veiculoId);
        if (!veiculo) return;
        const leads = db.prepare("SELECT * FROM leads WHERE estagio NOT IN ('fechado','fechado_ganho','comprou_outro','desqualificado','perdido') ORDER BY ai_score DESC LIMIT 30").all();
        matchStatus.rodando = true; matchStatus.total = leads.length; matchStatus.processados = 0; matchStatus.matches = []; matchStatus.log = ['🚗 Novo veículo adicionado: ' + veiculo.marca + ' ' + veiculo.modelo];
        for (const lead of leads) {
          try {
            const contexto = lead.conversa_historico ? lead.conversa_historico.substring(0,600) : ('Carro:'+lead.carro_interesse+' Parcela:'+lead.parcela_max+' Temp:'+lead.temperatura);
            const prompt = `Carro: ${veiculo.marca} ${veiculo.modelo} ${veiculo.ano||''} | Parcela:R$${veiculo.parcela_estimada||'?'} | Preço:R$${veiculo.preco||'?'}
Cliente: ${lead.nome} | ${contexto.substring(0,400)}
Este carro é adequado para este cliente? JSON: {"compativel":true_ou_false,"score_match":0_a_10,"motivo":"1 frase","argumento_venda":"abordagem personalizada","urgencia":"alta/media/baixa"}`;
            const txt = await claudeAI(prompt, 200);
            const data = parseJSON(txt);
            if (data && data.compativel && data.score_match >= 5) {
              matchStatus.matches.push({ lead_id:lead.id, lead_nome:lead.nome, lead_telefone:lead.telefone, lead_temperatura:lead.temperatura, lead_ai_score:lead.ai_score, veiculo_id:veiculoId, score_match:data.score_match, motivo:data.motivo, argumento_venda:data.argumento_venda, urgencia:data.urgencia });
              matchStatus.log.push('✅ ' + lead.nome + ' ('+data.score_match+'/10)');
              if (data.urgencia === 'alta') {
                const jaTemTarefa = db.prepare('SELECT id FROM tarefas WHERE lead_id=? AND concluida=0').get(lead.id);
                if (!jaTemTarefa) {
                  const amanha = new Date(); amanha.setDate(amanha.getDate()+1);
                  db.prepare('INSERT INTO tarefas (lead_id,titulo,descricao,tipo,data_vencimento,criada_por_ia) VALUES (?,?,?,?,?,1)').run(lead.id, '🚗 Oferecer '+veiculo.marca+' '+veiculo.modelo, data.argumento_venda||'', 'followup', amanha.toISOString().split('T')[0]);
                }
              }
            }
            matchStatus.processados++;
            await new Promise(r => setTimeout(r, 600));
          } catch(e) { matchStatus.log.push('❌ '+lead.nome+': '+e.message); }
        }
        matchStatus.rodando = false;
        matchStatus.log.push('🎉 '+matchStatus.matches.length+' matches para '+veiculo.marca+' '+veiculo.modelo);
        console.log('✅ Auto-match concluído:', matchStatus.matches.length);
      } catch(e) { console.error('Auto-match erro:', e.message); matchStatus.rodando = false; }
    }, 2000);
  }
});

app.put('/api/veiculos/:id', (req, res) => {
  const { marca, modelo, ano, versao, cor, km, preco, parcela_estimada, status, descricao } = req.body;
  db.prepare('UPDATE veiculos SET marca=?,modelo=?,ano=?,versao=?,cor=?,km=?,preco=?,parcela_estimada=?,status=?,descricao=? WHERE id=?')
    .run(marca, modelo, ano, versao, cor, km, preco, parcela_estimada, status, descricao, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/veiculos/:id', (req, res) => { db.prepare('DELETE FROM veiculos WHERE id=?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/veiculos/:id/match', (req, res) => {
  const v = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Não encontrado' });
  const matches = db.prepare("SELECT * FROM leads WHERE (LOWER(carro_interesse) LIKE ? OR LOWER(etiqueta)=LOWER(?)) AND estagio NOT IN ('fechado','fechado_ganho') AND (parcela_max IS NULL OR parcela_max >= ?) ORDER BY ai_score DESC")
    .all('%'+v.modelo.toLowerCase()+'%', v.modelo, v.parcela_estimada||0);
  res.json({ veiculo: v, matches });
});

app.get('/api/veiculos/exportar/excel', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(db.prepare('SELECT * FROM veiculos').all().map(v=>({ Marca:v.marca, Modelo:v.modelo, Ano:v.ano||'', Versão:v.versao||'', Cor:v.cor||'', KM:v.km||0, 'Preço':v.preco||'', 'Parcela':v.parcela_estimada||'', Status:v.status, Descrição:v.descricao||'' })));
  XLSX.utils.book_append_sheet(wb, ws, 'Estoque');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="estoque_${new Date().toISOString().split('T')[0]}.xlsx"`);
  res.send(buf);
});

app.get('/api/veiculos/template/excel', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([{ marca:'Ford', modelo:'Ka', ano:'2020', versao:'SE', cor:'Branco', km:45000, preco:58000, parcela_estimada:720, status:'disponivel', descricao:'Único dono' }]);
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="template_estoque.xlsx"');
  res.send(buf);
});

app.post('/api/veiculos/importar-excel', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo obrigatório' });
  try {
    const rows = XLSX.utils.sheet_to_json(XLSX.readFile(req.file.path).Sheets[XLSX.readFile(req.file.path).SheetNames[0]], { defval:'' });
    fs.unlinkSync(req.file.path);
    const get = (row,keys) => { const rk=Object.keys(row).map(k=>k.toLowerCase()); for(const k of keys){const i=rk.findIndex(r=>r.includes(k));if(i>=0)return Object.values(row)[i];} return ''; };
    let criados=0, duplicados=0, erros=0;
    for (const row of rows) {
      try {
        const marca=String(get(row,['marca'])||'').trim(), modelo=String(get(row,['modelo'])||'').trim();
        if(!marca||!modelo){erros++;continue;}
        const dup=db.prepare('SELECT id FROM veiculos WHERE LOWER(marca)=LOWER(?) AND LOWER(modelo)=LOWER(?)').get(marca,modelo);
        if(dup){duplicados++;continue;}
        db.prepare('INSERT INTO veiculos (marca,modelo,ano,versao,cor,km,preco,parcela_estimada,status,descricao) VALUES (?,?,?,?,?,?,?,?,?,?)').run(marca,modelo,String(get(row,['ano'])||''),String(get(row,['versao','versão'])||''),String(get(row,['cor'])||''),parseInt(String(get(row,['km'])||'0').replace(/\D/g,''))||0,parseFloat(String(get(row,['preco','preço','valor'])||'').replace(/[^0-9.]/g,''))||null,parseFloat(String(get(row,['parcela'])||'').replace(/[^0-9.]/g,''))||null,String(get(row,['status'])||'disponivel'),String(get(row,['descricao','descrição','obs'])||''));
        criados++;
      } catch{erros++;}
    }
    res.json({ criados, duplicados, erros, total: rows.length });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ─── DASHBOARD ────────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const t = s => db.prepare(s).get()?.n || 0;
    const total    = t('SELECT COUNT(*) as n FROM leads');
    const quentes  = t("SELECT COUNT(*) as n FROM leads WHERE temperatura='quente'");
    const frios    = t("SELECT COUNT(*) as n FROM leads WHERE temperatura='frio'");
    const followup = t("SELECT COUNT(*) as n FROM leads WHERE estagio NOT IN ('fechado','fechado_ganho','comprou_outro','desqualificado','perdido')");
    const fechados = t("SELECT COUNT(*) as n FROM leads WHERE estagio IN ('fechado','fechado_ganho')");
    const semana   = t("SELECT COUNT(*) as n FROM leads WHERE created_at >= datetime('now','-7 days','localtime')");
    const tarefas_hoje    = db.prepare('SELECT COUNT(*) as n FROM tarefas WHERE data_vencimento <= ? AND concluida=0').get(hoje)?.n || 0;
    const tarefas_vencidas = db.prepare("SELECT COUNT(*) as n FROM tarefas WHERE data_vencimento < ? AND concluida=0").get(hoje)?.n || 0;
    const por_etiqueta = db.prepare('SELECT etiqueta, COUNT(*) as total FROM leads GROUP BY etiqueta ORDER BY total DESC').all();
    const por_estagio  = db.prepare('SELECT estagio, COUNT(*) as total FROM leads GROUP BY estagio ORDER BY total DESC').all();
    const por_origem   = db.prepare('SELECT origem, COUNT(*) as total FROM leads GROUP BY origem ORDER BY total DESC').all();
    const leads_followup = db.prepare("SELECT l.*, CAST(julianday('now','localtime') - julianday(l.updated_at) AS INTEGER) as dias_parado FROM leads l WHERE l.estagio NOT IN ('fechado','fechado_ganho','comprou_outro','desqualificado','perdido') ORDER BY l.updated_at ASC LIMIT 30").all();
    const contato_hoje = db.prepare("SELECT * FROM leads WHERE proximo_contato <= ? AND estagio NOT IN ('fechado','fechado_ganho','comprou_outro','desqualificado','perdido') ORDER BY proximo_contato ASC").all(hoje);
    let aniversarios = [];
    try { aniversarios = db.prepare("SELECT id,nome,telefone FROM leads WHERE data_nascimento IS NOT NULL AND data_nascimento!='' AND substr(data_nascimento,6,5)=?").all(hoje.slice(5)); } catch(e){}
    const veiculos_disponiveis = t("SELECT COUNT(*) as n FROM veiculos WHERE status='disponivel'");
    const taxa_conversao = total > 0 ? ((fechados/total)*100).toFixed(1) : '0.0';
    res.json({ total, quentes, frios, followup, fechados, semana, taxa_conversao, tarefas_hoje, tarefas_vencidas, por_etiqueta, por_estagio, por_origem, leads_followup, contato_hoje, aniversarios, veiculos_disponiveis });
  } catch(e) {
    console.error('Dashboard erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/relatorio/semanal', (req, res) => {
  res.json({
    leads_semana:       db.prepare("SELECT COUNT(*) as n FROM leads WHERE created_at >= datetime('now','-7 days','localtime')").get()?.n || 0,
    quentes_semana:     db.prepare("SELECT COUNT(*) as n FROM leads WHERE created_at >= datetime('now','-7 days','localtime') AND temperatura='quente'").get()?.n || 0,
    fechados_semana:    db.prepare("SELECT COUNT(*) as n FROM leads WHERE created_at >= datetime('now','-7 days','localtime') AND estagio IN ('fechado','fechado_ganho')").get()?.n || 0,
    tarefas_concluidas: db.prepare("SELECT COUNT(*) as n FROM tarefas WHERE concluida=1 AND concluida_em >= datetime('now','-7 days','localtime')").get()?.n || 0,
    melhor_etiqueta:    db.prepare("SELECT etiqueta, COUNT(*) as total FROM leads WHERE created_at >= datetime('now','-7 days','localtime') GROUP BY etiqueta ORDER BY total DESC LIMIT 1").get() || null,
  });
});

// ─── KANBAN ───────────────────────────────────────────────────────
app.get('/api/kanban', (req, res) => {
  const estagios = ['novo','interessado','pediu_proposta','em_negociacao','sumiu','compra_futura','fechado_ganho','comprou_outro','desqualificado','perdido'];
  const resultado = {};
  estagios.forEach(est => {
    resultado[est] = db.prepare(`SELECT id,nome,telefone,carro_interesse,parcela_max,temperatura,etiqueta,ai_score, CAST(julianday('now','localtime') - julianday(updated_at) AS INTEGER) as dias_parado, (SELECT COUNT(*) FROM tarefas WHERE lead_id=leads.id AND concluida=0) as tarefas_pendentes FROM leads WHERE estagio=? ORDER BY ai_score DESC, updated_at DESC LIMIT 30`).all(est);
  });
  res.json(resultado);
});

// ─── CONFIG & SHEETS ──────────────────────────────────────────────
const configPath = path.join(__dirname, 'config.json');
const getConfig = () => { try { return JSON.parse(fs.readFileSync(configPath,'utf8')); } catch { return {}; } };
const saveConfig = c => fs.writeFileSync(configPath, JSON.stringify(c, null, 2));

app.get('/api/config', (req, res) => res.json(getConfig()));
app.post('/api/config', (req, res) => { saveConfig(req.body); res.json({ ok: true }); });

app.post('/api/sheets/sync', async (req, res) => {
  const cfg = getConfig();
  if (!cfg.sheets_url) return res.status(400).json({ error: 'URL do Google Sheets não configurada' });
  const match = cfg.sheets_url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return res.status(400).json({ error: 'URL inválida' });
  try {
    const r = await axios.get(`https://docs.google.com/spreadsheets/d/${match[1]}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(cfg.sheets_tab||'Sheet1')}`, { timeout:15000, responseType:'text' });
    const linhas = r.data.split('\n').map(l=>l.replace(/"/g,'').trim()).filter(Boolean);
    if (linhas.length < 2) return res.status(400).json({ error: 'Planilha vazia' });
    const header = linhas[0].split(',').map(h=>h.toLowerCase().trim());
    const fi = keys => { for(const k of keys){const i=header.findIndex(h=>h.includes(k));if(i>=0)return i;} return -1; };
    const iTel=fi(['telefone','celular','whatsapp']), iNome=fi(['nome','name','cliente']);
    if(iTel<0) return res.status(400).json({ error: 'Coluna telefone não encontrada' });
    let criados=0, duplicados=0, erros=0;
    for (let i=1; i<linhas.length; i++) {
      try {
        const cols = linhas[i].split(',');
        const tel = cols[iTel]?.replace(/\D/g,'')||'';
        if(!tel||tel.length<8){erros++;continue;}
        const dup = db.prepare("SELECT id FROM leads WHERE replace(replace(telefone,'-',''),' ','') LIKE ?").get('%'+tel.slice(-8));
        if(dup){duplicados++;continue;}
        db.prepare("INSERT INTO leads (nome,telefone,origem,etiqueta,temperatura,estagio) VALUES (?,?,?,?,?,?)").run(iNome>=0?cols[iNome]?.trim()||'Lead do Sheets':'Lead do Sheets', tel, 'Google Sheets', 'geral', 'morno', 'novo');
        criados++;
      } catch{erros++;}
    }
    res.json({ criados, duplicados, erros, total: linhas.length-1 });
  } catch(e) { res.status(500).json({ error: 'Erro ao acessar planilha. Verifique se está pública.' }); }
});

// ─── WEBHOOK WASPEED ──────────────────────────────────────────────
// (o require('./webhook') falhou — coloca inline)
app.post('/api/webhook/waspeed', async (req, res) => {
  try {
    const p = req.body || {};
    const tel = String(p.numero||p.phone||p.telefone||p.number||'').replace(/\D/g,'');
    if (!tel || tel.length < 8) return res.status(400).json({ error: 'Número inválido' });
    const nome = p.nome||p.name||p.contato||'Lead WhatsApp';
    const etiq = { ka:'Ka', cruze:'Cruze', hb20:'HB20', onix:'Onix', toro:'Toro' }[(p.etiqueta||'').toLowerCase()] || 'geral';
    const mensagem = Array.isArray(p.mensagens) ? p.mensagens.map(m=>m.texto||m.text||m.body||m).filter(Boolean).join('\n') : (p.mensagem||p.message||'');
    const dup = db.prepare("SELECT id,nome FROM leads WHERE replace(replace(replace(telefone,'-',''),' ',''),'(','') LIKE ?").get('%'+tel.slice(-8));
    if (dup) {
      if (mensagem) {
        db.prepare('INSERT INTO anotacoes (lead_id, tipo, conteudo) VALUES (?,?,?)').run(dup.id, 'nota', '📱 Nova mensagem: '+mensagem.substring(0,500));
        db.prepare("UPDATE leads SET updated_at=datetime('now','localtime') WHERE id=?").run(dup.id);
      }
      return res.json({ ok:true, acao:'atualizado', lead_id:dup.id });
    }
    const r = db.prepare("INSERT INTO leads (nome,telefone,origem,etiqueta,temperatura,estagio,conversa_historico) VALUES (?,?,?,?,?,?,?)").run(String(nome).trim()||'Lead WhatsApp', tel, 'WhatsApp/Waspeed', etiq, 'morno', 'novo', mensagem||null);
    if (mensagem) {
      const amanha = new Date(); amanha.setDate(amanha.getDate()+1);
      db.prepare('INSERT INTO tarefas (lead_id,titulo,descricao,tipo,data_vencimento,criada_por_ia) VALUES (?,?,?,?,?,0)').run(r.lastInsertRowid, 'Retornar contato — '+nome, 'Novo lead via WhatsApp', 'followup', amanha.toISOString().split('T')[0]);
    }
    res.json({ ok:true, acao:'criado', lead_id:r.lastInsertRowid });
  } catch(e) { console.error('Webhook erro:', e.message); res.status(500).json({ error: e.message }); }
});


// ─── MATCH IA: CARRO + LEADS ─────────────────────────────────────
// Status do processo de match em memória
const matchStatus = { rodando: false, total: 0, processados: 0, matches: [], log: [] };

app.get('/api/match/status', (req, res) => res.json(matchStatus));

// Calcula match de UM carro com TODOS os leads
app.post('/api/match/calcular/:veiculo_id', async (req, res) => {
  const veiculo = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.veiculo_id);
  if (!veiculo) return res.status(404).json({ error: 'Veículo não encontrado' });

  // Match básico por dados (rápido, sem IA)
  const leads_basico = db.prepare(`
    SELECT l.*, CAST(julianday('now','localtime') - julianday(l.updated_at) AS INTEGER) as dias_parado
    FROM leads l
    WHERE l.estagio NOT IN ('fechado','fechado_ganho','comprou_outro','desqualificado','perdido')
    AND (
      LOWER(l.carro_interesse) LIKE ? OR
      LOWER(l.etiqueta) = LOWER(?) OR
      l.parcela_max IS NULL OR
      (l.parcela_max >= ?)
    )
    ORDER BY l.ai_score DESC, l.temperatura DESC
    LIMIT 50
  `).all(
    '%' + veiculo.modelo.toLowerCase() + '%',
    veiculo.modelo,
    veiculo.parcela_estimada || 0
  );

  res.json({ veiculo, leads_basico, total_basico: leads_basico.length });

  // Match IA em background (analisa conversa vs carro)
  if (ANTHROPIC_KEY && leads_basico.length > 0) {
    (async () => {
      matchStatus.rodando = true;
      matchStatus.total = leads_basico.length;
      matchStatus.processados = 0;
      matchStatus.matches = [];
      matchStatus.log = [`🔍 Analisando ${leads_basico.length} leads para ${veiculo.marca} ${veiculo.modelo}...`];

      for (const lead of leads_basico) {
        try {
          const contexto = lead.conversa_historico
            ? `Conversa:
${lead.conversa_historico.substring(0, 800)}`
            : `Dados: Carro interesse: ${lead.carro_interesse||'?'} | Parcela max: R$${lead.parcela_max||'?'} | Temperatura: ${lead.temperatura} | Observações: ${lead.observacoes||'nenhuma'}`;

          const prompt = `Você é consultor de vendas de carros. Avalie se este CARRO é adequado para este CLIENTE.

CARRO DISPONÍVEL:
${veiculo.marca} ${veiculo.modelo} ${veiculo.ano||''} ${veiculo.versao||''}
Cor: ${veiculo.cor||'?'} | KM: ${veiculo.km||0} | Preço: R$${veiculo.preco||'?'} | Parcela: ~R$${veiculo.parcela_estimada||'?'}/mês
${veiculo.descricao||''}

CLIENTE: ${lead.nome}
${contexto}

Retorne APENAS JSON sem markdown:
{
  "compativel": true_ou_false,
  "score_match": 0_a_10,
  "motivo": "justificativa em 1-2 frases por que é ou não compatível",
  "argumento_venda": "mensagem personalizada de 1-2 frases para abordar o cliente sobre este carro",
  "urgencia": "alta ou media ou baixa"
}`;

          const txt = await claudeAI(prompt, 300);
          const data = parseJSON(txt);

          if (data && data.compativel && data.score_match >= 5) {
            matchStatus.matches.push({
              lead_id: lead.id,
              lead_nome: lead.nome,
              lead_telefone: lead.telefone,
              lead_temperatura: lead.temperatura,
              lead_ai_score: lead.ai_score,
              lead_carro: lead.carro_interesse,
              lead_parcela: lead.parcela_max,
              veiculo_id: veiculo.id,
              score_match: data.score_match,
              motivo: data.motivo,
              argumento_venda: data.argumento_venda,
              urgencia: data.urgencia,
            });
            matchStatus.log.push(`✅ Match! ${lead.nome} (${data.score_match}/10) — ${data.motivo}`);

            // Cria tarefa automática para leads com alta urgência
            if (data.urgencia === 'alta') {
              const jaTemTarefa = db.prepare('SELECT id FROM tarefas WHERE lead_id=? AND concluida=0').get(lead.id);
              if (!jaTemTarefa) {
                const amanha = new Date(); amanha.setDate(amanha.getDate()+1);
                db.prepare('INSERT INTO tarefas (lead_id,titulo,descricao,tipo,data_vencimento,criada_por_ia) VALUES (?,?,?,?,?,1)')
                  .run(lead.id,
                    `🚗 Oferecer ${veiculo.marca} ${veiculo.modelo} para ${lead.nome}`,
                    data.argumento_venda || `Temos o ${veiculo.marca} ${veiculo.modelo} disponível que pode interessar ao cliente.`,
                    'followup',
                    amanha.toISOString().split('T')[0]
                  );
              }
            }
          } else if (data) {
            matchStatus.log.push(`⬜ ${lead.nome}: score ${data.score_match||0}/10 — ${data.motivo||'não compatível'}`);
          }

          matchStatus.processados++;
          if (matchStatus.log.length > 80) matchStatus.log = matchStatus.log.slice(-60);
        } catch(e) {
          matchStatus.log.push(`❌ ${lead.nome}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 700));
      }

      matchStatus.rodando = false;
      matchStatus.log.push(`🎉 Concluído! ${matchStatus.matches.length} matches encontrados de ${leads_basico.length} leads analisados.`);
      console.log('✅ Match IA concluído:', matchStatus.matches.length, 'matches');
    })();
  }
});

// Lista todos os matches do último cálculo
app.get('/api/match/resultado', (req, res) => {
  res.json({
    status: matchStatus,
    matches: matchStatus.matches.sort((a,b) => b.score_match - a.score_match)
  });
});

// Match rápido (sem IA) para um veículo
app.get('/api/match/rapido/:veiculo_id', (req, res) => {
  const v = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.veiculo_id);
  if (!v) return res.status(404).json({ error: 'Não encontrado' });
  const leads = db.prepare(`
    SELECT l.*, CAST(julianday('now','localtime') - julianday(l.updated_at) AS INTEGER) as dias_parado
    FROM leads l
    WHERE l.estagio NOT IN ('fechado','fechado_ganho','comprou_outro','desqualificado','perdido')
    AND (LOWER(l.carro_interesse) LIKE ? OR LOWER(l.etiqueta)=LOWER(?) OR (l.parcela_max IS NULL OR l.parcela_max >= ?))
    ORDER BY l.ai_score DESC, l.temperatura DESC LIMIT 30
  `).all('%'+v.modelo.toLowerCase()+'%', v.modelo, v.parcela_estimada||0);
  res.json({ veiculo: v, leads, total: leads.length });
});

// Arquivos PWA — servidos explicitamente com Content-Type correto
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'frontend', 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'frontend', 'manifest.json'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));

app.listen(PORT, () => {
  console.log(`🚗 CRM Autos Pro rodando na porta ${PORT}`);
  const hoje = new Date().toISOString().split('T')[0];
  const relHoje = db.prepare("SELECT id FROM ai_relatorios WHERE created_at LIKE ? AND tipo='diario'").get(hoje+'%');
  if (!relHoje && ANTHROPIC_KEY) setTimeout(gerarRelatorio, 10000);
});
