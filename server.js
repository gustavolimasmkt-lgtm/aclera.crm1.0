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

app.post('/api/webhook/waspeed', (req, res) => {
  try {
    const p = req.body || {};
    const tel = String(p.numero||p.phone||p.telefone||'').replace(/\D/g,'');
    if (!tel || tel.length < 8) return res.status(400).json({ error: 'Número inválido' });
    const nome = p.nome||p.name||'Lead WhatsApp';
    const mensagem = Array.isArray(p.mensagens) ? p.mensagens.map(m=>m.texto||m.text||m).filter(Boolean).join('\n') : (p.mensagem||p.message||'');
    const dup = db.prepare("SELECT id,nome FROM leads WHERE replace(replace(telefone,'-',''),' ','') LIKE ?").get('%'+tel.slice(-8));
    if (dup) {
      if (mensagem) db.prepare('INSERT INTO anotacoes (lead_id,tipo,conteudo) VALUES (?,?,?)').run(dup.id,'nota','📱 Nova mensagem: '+mensagem.substring(0,500));
      return res.json({ ok:true, acao:'atualizado', lead_id:dup.id });
    }
    const r = db.prepare("INSERT INTO leads (nome,telefone,origem,temperatura,estagio_id,conversa_historico) VALUES (?,?,?,?,(SELECT id FROM estagios ORDER BY posicao ASC LIMIT 1),?)").run(String(nome).trim()||'Lead WhatsApp', tel, 'WhatsApp/Waspeed', 'morno', mensagem||null);
    res.json({ ok:true, acao:'criado', lead_id:r.lastInsertRowid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/webhook/waspeed', (req, res) => res.json({ ok: true, status: 'webhook ativo' }));

app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  if (req.path.startsWith('/webhook/')) return next();
  const token = req.headers['x-session-token'] || req.query.token;
  if (!sessions.has(token)) return res.status(401).json({ error: 'Não autorizado' });
  sessions.delete(token);
  sessions.add(token);
  setTimeout(() => sessions.delete(token), 24 * 60 * 60 * 1000);
  next();
});

// ─── BANCO ────────────────────────────────────────────────────────
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'crm.db')
  : path.join(__dirname, 'crm.db');
console.log('📂 Banco:', DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS estagios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    cor TEXT DEFAULT '#3b82f6',
    posicao INTEGER DEFAULT 0,
    fixo INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL DEFAULT 'Lead',
    telefone TEXT NOT NULL DEFAULT '',
    email TEXT,
    carro_interesse TEXT,
    parcela_max REAL,
    tem_troca INTEGER DEFAULT 0,
    carro_troca TEXT,
    temperatura TEXT DEFAULT 'morno',
    estagio_id INTEGER,
    origem TEXT DEFAULT 'Meta Ads',
    observacoes TEXT,
    conversa_historico TEXT,
    ai_score INTEGER DEFAULT 0,
    ai_insight TEXT,
    ai_sugestao TEXT,
    proximo_contato TEXT,
    ultimo_contato TEXT,
    data_nascimento TEXT,
    motivo_perda TEXT,
    duplicado INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (estagio_id) REFERENCES estagios(id)
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

  CREATE TABLE IF NOT EXISTS ai_relatorios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Estágios padrão
const estagiosPadrao = [
  { nome: 'Novo', cor: '#3b82f6', posicao: 0, fixo: 1 },
  { nome: 'Interessado', cor: '#8b5cf6', posicao: 1, fixo: 0 },
  { nome: 'Pediu proposta', cor: '#f59e0b', posicao: 2, fixo: 0 },
  { nome: 'Em negociação', cor: '#f97316', posicao: 3, fixo: 0 },
  { nome: 'Sumiu', cor: '#6b7280', posicao: 4, fixo: 0 },
  { nome: 'Compra futura', cor: '#6366f1', posicao: 5, fixo: 0 },
  { nome: 'Comprou ✅', cor: '#22c55e', posicao: 6, fixo: 1 },
  { nome: 'Outro lugar 🔴', cor: '#ef4444', posicao: 7, fixo: 1 },
  { nome: 'Perdido ❌', cor: '#dc2626', posicao: 8, fixo: 1 },
];
estagiosPadrao.forEach(e => {
  try { db.prepare('INSERT OR IGNORE INTO estagios (nome,cor,posicao,fixo) VALUES (?,?,?,?)').run(e.nome,e.cor,e.posicao,e.fixo); } catch(err) {}
});

// Migrations
[
  'ALTER TABLE leads ADD COLUMN conversa_historico TEXT',
  'ALTER TABLE leads ADD COLUMN proximo_contato TEXT',
  'ALTER TABLE leads ADD COLUMN ultimo_contato TEXT',
  'ALTER TABLE leads ADD COLUMN ai_insight TEXT',
  'ALTER TABLE leads ADD COLUMN ai_sugestao TEXT',
  'ALTER TABLE leads ADD COLUMN duplicado INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN data_nascimento TEXT',
  'ALTER TABLE leads ADD COLUMN motivo_perda TEXT',
  'ALTER TABLE leads ADD COLUMN email TEXT',
  'ALTER TABLE leads ADD COLUMN estagio_id INTEGER',
  'ALTER TABLE tarefas ADD COLUMN criada_por_ia INTEGER DEFAULT 0',
  'ALTER TABLE tarefas ADD COLUMN concluida_em TEXT',
  'ALTER TABLE tarefas ADD COLUMN descricao TEXT',
  'ALTER TABLE anotacoes ADD COLUMN tipo TEXT DEFAULT "nota"',
].forEach(sql => { try { db.prepare(sql).run(); } catch(e) {} });

// Migra leads antigos com estagio TEXT para estagio_id
try {
  const temEstagio = db.prepare("SELECT name FROM pragma_table_info('leads') WHERE name='estagio'").get();
  if (temEstagio) {
    const leadsAntigos = db.prepare("SELECT id, estagio FROM leads WHERE estagio_id IS NULL AND estagio IS NOT NULL").all();
    leadsAntigos.forEach(l => {
      const mapaEstagio = {
        'novo': 'Novo', 'interessado': 'Interessado', 'pediu_proposta': 'Pediu proposta',
        'em_negociacao': 'Em negociação', 'sumiu': 'Sumiu', 'compra_futura': 'Compra futura',
        'fechado': 'Comprou ✅', 'fechado_ganho': 'Comprou ✅', 'comprou_outro': 'Outro lugar 🔴',
        'desqualificado': 'Perdido ❌', 'perdido': 'Perdido ❌',
      };
      const nomeEstagio = mapaEstagio[l.estagio] || 'Novo';
      const est = db.prepare('SELECT id FROM estagios WHERE nome=?').get(nomeEstagio);
      if (est) db.prepare('UPDATE leads SET estagio_id=? WHERE id=?').run(est.id, l.id);
    });
    if (leadsAntigos.length) console.log(`✅ Migrados ${leadsAntigos.length} leads para estagio_id`);
  }
} catch(e) { console.log('Migration estagio:', e.message); }

// Garante que leads sem estagio_id ganham o primeiro estágio
try {
  const primeiro = db.prepare('SELECT id FROM estagios ORDER BY posicao ASC LIMIT 1').get();
  if (primeiro) db.prepare('UPDATE leads SET estagio_id=? WHERE estagio_id IS NULL').run(primeiro.id);
} catch(e) {}

console.log('✅ Banco ok');

// ─── IA ───────────────────────────────────────────────────────────
async function claudeAI(prompt, maxTokens = 600) {
  if (!ANTHROPIC_KEY) return null;
  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 30000 });
    return r.data.content[0].text;
  } catch(e) { console.error('IA erro:', e?.response?.data?.error?.message || e.message); return null; }
}

function parseJSON(txt) {
  if (!txt) return null;
  try { return JSON.parse(txt.replace(/```json|```/g,'').trim()); } catch { return null; }
}

// ─── ESTÁGIOS ────────────────────────────────────────────────────
app.get('/api/estagios', (req, res) => {
  res.json(db.prepare('SELECT * FROM estagios ORDER BY posicao ASC').all());
});

app.post('/api/estagios', (req, res) => {
  const { nome, cor } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  const maxPos = db.prepare('SELECT MAX(posicao) as m FROM estagios').get().m || 0;
  try {
    const r = db.prepare('INSERT INTO estagios (nome,cor,posicao,fixo) VALUES (?,?,?,0)')
      .run(nome.trim(), cor || '#3b82f6', maxPos + 1);
    res.json({ id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: 'Estágio já existe' }); }
});

app.put('/api/estagios/:id', (req, res) => {
  const { nome, cor, posicao } = req.body;
  const est = db.prepare('SELECT * FROM estagios WHERE id=?').get(req.params.id);
  if (!est) return res.status(404).json({ error: 'Não encontrado' });
  db.prepare('UPDATE estagios SET nome=COALESCE(?,nome), cor=COALESCE(?,cor), posicao=COALESCE(?,posicao) WHERE id=?')
    .run(nome||null, cor||null, posicao??null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/estagios/:id', (req, res) => {
  const est = db.prepare('SELECT * FROM estagios WHERE id=?').get(req.params.id);
  if (!est) return res.status(404).json({ error: 'Não encontrado' });
  if (est.fixo) return res.status(400).json({ error: 'Estágio padrão não pode ser removido' });
  // Move leads para o primeiro estágio
  const primeiro = db.prepare('SELECT id FROM estagios WHERE id!=? ORDER BY posicao ASC LIMIT 1').get(req.params.id);
  if (primeiro) db.prepare('UPDATE leads SET estagio_id=? WHERE estagio_id=?').run(primeiro.id, req.params.id);
  db.prepare('DELETE FROM estagios WHERE id=?').run(req.params.id);
  res.json({ ok: true, leads_movidos: primeiro?.id });
});

// Reordenar estágios
app.put('/api/estagios/reordenar', (req, res) => {
  const { ordem } = req.body; // array de ids na nova ordem
  if (!Array.isArray(ordem)) return res.status(400).json({ error: 'ordem deve ser array' });
  ordem.forEach((id, idx) => {
    db.prepare('UPDATE estagios SET posicao=? WHERE id=?').run(idx, id);
  });
  res.json({ ok: true });
});

// ─── LEADS ────────────────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  const { estagio_id, temperatura, busca, ordenar } = req.query;
  let q = `SELECT l.*,
    e.nome as estagio_nome, e.cor as estagio_cor,
    CAST(julianday('now','localtime') - julianday(l.updated_at) AS INTEGER) as dias_parado,
    CAST(julianday('now','localtime') - julianday(COALESCE(l.ultimo_contato, l.created_at)) AS INTEGER) as dias_sem_contato,
    (SELECT COUNT(*) FROM tarefas WHERE lead_id=l.id AND concluida=0) as tarefas_pendentes,
    (SELECT COUNT(*) FROM tarefas WHERE lead_id=l.id AND concluida=0 AND data_vencimento < date('now','localtime')) as tarefas_vencidas
    FROM leads l LEFT JOIN estagios e ON l.estagio_id=e.id WHERE 1=1`;
  const p = [];
  if (estagio_id) { q += ' AND l.estagio_id=?'; p.push(estagio_id); }
  if (temperatura) { q += ' AND l.temperatura=?'; p.push(temperatura); }
  if (busca) { q += ' AND (l.nome LIKE ? OR l.telefone LIKE ? OR l.carro_interesse LIKE ?)'; p.push(`%${busca}%`,`%${busca}%`,`%${busca}%`); }
  if (ordenar === 'score') q += ' ORDER BY l.ai_score DESC, l.updated_at DESC';
  else if (ordenar === 'parado') q += ' ORDER BY dias_parado DESC';
  else if (ordenar === 'nome') q += ' ORDER BY l.nome ASC';
  else if (ordenar === 'contato') q += ' ORDER BY dias_sem_contato DESC';
  else q += ' ORDER BY l.updated_at DESC';
  res.json(db.prepare(q).all(...p));
});

app.get('/api/leads/:id', (req, res) => {
  const lead = db.prepare(`SELECT l.*, e.nome as estagio_nome, e.cor as estagio_cor,
    CAST(julianday('now','localtime') - julianday(l.updated_at) AS INTEGER) as dias_parado
    FROM leads l LEFT JOIN estagios e ON l.estagio_id=e.id WHERE l.id=?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Não encontrado' });
  lead.anotacoes = db.prepare('SELECT * FROM anotacoes WHERE lead_id=? ORDER BY created_at DESC LIMIT 20').all(req.params.id);
  lead.tarefas = db.prepare('SELECT * FROM tarefas WHERE lead_id=? ORDER BY concluida ASC, data_vencimento ASC').all(req.params.id);
  res.json(lead);
});

app.post('/api/leads', (req, res) => {
  const { nome, telefone, email, carro_interesse, parcela_max, tem_troca, carro_troca, temperatura, estagio_id, origem, observacoes, conversa_historico, data_nascimento } = req.body;
  if (!nome || !telefone) return res.status(400).json({ error: 'Nome e telefone obrigatórios' });
  const tel = telefone.replace(/\D/g,'');
  const dup = db.prepare("SELECT id FROM leads WHERE replace(replace(telefone,'-',''),' ','') LIKE ?").get('%'+tel.slice(-8));
  // Pega primeiro estágio se não especificado
  const estId = estagio_id || db.prepare('SELECT id FROM estagios ORDER BY posicao ASC LIMIT 1').get()?.id;
  const r = db.prepare(`INSERT INTO leads (nome,telefone,email,carro_interesse,parcela_max,tem_troca,carro_troca,temperatura,estagio_id,origem,observacoes,conversa_historico,data_nascimento,duplicado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nome, tel, email||null, carro_interesse||null, parcela_max||null, tem_troca?1:0, carro_troca||null, temperatura||'morno', estId, origem||'Meta Ads', observacoes||null, conversa_historico||null, data_nascimento||null, dup?1:0);
  res.json({ id: r.lastInsertRowid, duplicado: !!dup, duplicado_id: dup?.id });
});

app.put('/api/leads/:id', (req, res) => {
  const { nome, telefone, email, carro_interesse, parcela_max, tem_troca, carro_troca, temperatura, estagio_id, origem, observacoes, conversa_historico, proximo_contato, ultimo_contato, data_nascimento, motivo_perda } = req.body;
  db.prepare(`UPDATE leads SET nome=?,telefone=?,email=?,carro_interesse=?,parcela_max=?,tem_troca=?,carro_troca=?,temperatura=?,estagio_id=?,origem=?,observacoes=?,conversa_historico=COALESCE(?,conversa_historico),proximo_contato=?,ultimo_contato=?,data_nascimento=?,motivo_perda=?,updated_at=datetime('now','localtime') WHERE id=?`)
    .run(nome,(telefone||'').replace(/\D/g,''),email||null,carro_interesse||null,parcela_max||null,tem_troca?1:0,carro_troca||null,temperatura||'morno',estagio_id,origem||'Meta Ads',observacoes||null,conversa_historico||null,proximo_contato||null,ultimo_contato||null,data_nascimento||null,motivo_perda||null,req.params.id);
  res.json({ ok: true });
});

// Mover estágio (com motivo de perda obrigatório)
app.put('/api/leads/:id/estagio', (req, res) => {
  const { estagio_id, motivo_perda } = req.body;
  const est = db.prepare('SELECT * FROM estagios WHERE id=?').get(estagio_id);
  if (!est) return res.status(400).json({ error: 'Estágio inválido' });
  // Estágios que exigem motivo
  const precisaMotivo = ['Perdido ❌', 'Outro lugar 🔴'];
  if (precisaMotivo.includes(est.nome) && !motivo_perda) {
    return res.status(400).json({ error: 'motivo_perda obrigatório', pede_motivo: true, estagio_nome: est.nome });
  }
  db.prepare(`UPDATE leads SET estagio_id=?, motivo_perda=COALESCE(?,motivo_perda), updated_at=datetime('now','localtime') WHERE id=?`)
    .run(estagio_id, motivo_perda||null, req.params.id);
  res.json({ ok: true });
});

// Registrar contato com 1 clique
app.post('/api/leads/:id/registrar-contato', (req, res) => {
  const { nota } = req.body;
  const agora = new Date().toISOString().split('T')[0];
  db.prepare(`UPDATE leads SET ultimo_contato=?, updated_at=datetime('now','localtime') WHERE id=?`).run(agora, req.params.id);
  const lead = db.prepare('SELECT nome FROM leads WHERE id=?').get(req.params.id);
  const texto = nota ? `📞 Contato registrado: ${nota}` : `📞 Contato registrado`;
  db.prepare('INSERT INTO anotacoes (lead_id,tipo,conteudo) VALUES (?,?,?)').run(req.params.id,'nota',texto);
  res.json({ ok: true, data: agora });
});

// Agendar próximo contato
app.post('/api/leads/:id/agendar', (req, res) => {
  const { data, nota } = req.body;
  if (!data) return res.status(400).json({ error: 'Data obrigatória' });
  db.prepare(`UPDATE leads SET proximo_contato=?, updated_at=datetime('now','localtime') WHERE id=?`).run(data, req.params.id);
  if (nota) db.prepare('INSERT INTO anotacoes (lead_id,tipo,conteudo) VALUES (?,?,?)').run(req.params.id,'nota',`📅 Próximo contato agendado para ${data}: ${nota}`);
  // Cria tarefa automática
  const lead = db.prepare('SELECT nome FROM leads WHERE id=?').get(req.params.id);
  db.prepare('INSERT INTO tarefas (lead_id,titulo,tipo,data_vencimento) VALUES (?,?,?,?)').run(req.params.id, `Contato com ${lead?.nome||'Lead'}`, 'followup', data);
  res.json({ ok: true });
});

app.delete('/api/leads/:id', (req, res) => {
  db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/leads/:id/anotacao', (req, res) => {
  const { conteudo, tipo } = req.body;
  if (!conteudo) return res.status(400).json({ error: 'Conteúdo obrigatório' });
  db.prepare('INSERT INTO anotacoes (lead_id,tipo,conteudo) VALUES (?,?,?)').run(req.params.id, tipo||'nota', conteudo);
  db.prepare(`UPDATE leads SET updated_at=datetime('now','localtime') WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ─── TAREFAS ──────────────────────────────────────────────────────
app.get('/api/tarefas', (req, res) => {
  const { lead_id, pendentes, vencidas } = req.query;
  let q = `SELECT t.*, l.nome as lead_nome, l.telefone as lead_telefone FROM tarefas t JOIN leads l ON t.lead_id=l.id WHERE 1=1`;
  const p = [];
  if (lead_id) { q += ' AND t.lead_id=?'; p.push(lead_id); }
  if (pendentes) q += ' AND t.concluida=0';
  if (vencidas) q += " AND t.data_vencimento < date('now','localtime') AND t.concluida=0";
  q += ' ORDER BY t.concluida ASC, t.data_vencimento ASC, t.created_at DESC';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/tarefas', (req, res) => {
  const { lead_id, titulo, descricao, tipo, data_vencimento } = req.body;
  if (!lead_id || !titulo) return res.status(400).json({ error: 'lead_id e titulo obrigatórios' });
  const r = db.prepare('INSERT INTO tarefas (lead_id,titulo,descricao,tipo,data_vencimento) VALUES (?,?,?,?,?)').run(lead_id,titulo,descricao||null,tipo||'followup',data_vencimento||null);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/tarefas/:id/concluir', (req, res) => {
  const t = db.prepare('SELECT * FROM tarefas WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Não encontrada' });
  db.prepare(`UPDATE tarefas SET concluida=1, concluida_em=datetime('now','localtime') WHERE id=?`).run(req.params.id);
  db.prepare('INSERT INTO anotacoes (lead_id,tipo,conteudo) VALUES (?,?,?)').run(t.lead_id,'tarefa_concluida','✅ '+t.titulo);
  db.prepare(`UPDATE leads SET updated_at=datetime('now','localtime') WHERE id=?`).run(t.lead_id);
  res.json({ ok: true });
});

app.delete('/api/tarefas/:id', (req, res) => {
  db.prepare('DELETE FROM tarefas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── DASHBOARD / PAINEL DO DIA ────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const t = s => db.prepare(s).get()?.n || 0;
    const total = t('SELECT COUNT(*) as n FROM leads');
    const quentes = t("SELECT COUNT(*) as n FROM leads WHERE temperatura='quente'");
    // Painel do dia
    const contato_hoje = db.prepare("SELECT l.*, e.nome as estagio_nome, e.cor as estagio_cor FROM leads l LEFT JOIN estagios e ON l.estagio_id=e.id WHERE l.proximo_contato <= ? AND e.nome NOT IN ('Comprou ✅','Outro lugar 🔴','Perdido ❌') ORDER BY l.proximo_contato ASC LIMIT 20").all(hoje);
    const tarefas_hoje = db.prepare("SELECT t.*, l.nome as lead_nome, l.telefone as lead_telefone FROM tarefas t JOIN leads l ON t.lead_id=l.id WHERE t.data_vencimento <= ? AND t.concluida=0 ORDER BY t.data_vencimento ASC").all(hoje);
    const sem_contato = db.prepare("SELECT l.*, e.nome as estagio_nome, e.cor as estagio_cor, CAST(julianday('now','localtime') - julianday(COALESCE(l.ultimo_contato,l.created_at)) AS INTEGER) as dias_sem FROM leads l LEFT JOIN estagios e ON l.estagio_id=e.id WHERE e.nome NOT IN ('Comprou ✅','Outro lugar 🔴','Perdido ❌') AND (l.ultimo_contato IS NULL OR l.ultimo_contato < date('now','-3 days','localtime')) ORDER BY dias_sem DESC LIMIT 10").all();
    let aniversarios = [];
    try { aniversarios = db.prepare("SELECT id,nome,telefone,data_nascimento FROM leads WHERE data_nascimento IS NOT NULL AND substr(data_nascimento,6,5)=?").all(hoje.slice(5)); } catch(e){}
    const por_estagio = db.prepare("SELECT e.id, e.nome, e.cor, COUNT(l.id) as total FROM estagios e LEFT JOIN leads l ON l.estagio_id=e.id GROUP BY e.id ORDER BY e.posicao ASC").all();
    const fechados_mes = db.prepare("SELECT COUNT(*) as n FROM leads l JOIN estagios e ON l.estagio_id=e.id WHERE e.nome='Comprou ✅' AND l.updated_at >= datetime('now','-30 days','localtime')").get()?.n || 0;
    const taxa = total > 0 ? ((db.prepare("SELECT COUNT(*) as n FROM leads l JOIN estagios e ON l.estagio_id=e.id WHERE e.nome='Comprou ✅'").get()?.n || 0) / total * 100).toFixed(1) : '0.0';
    res.json({ total, quentes, contato_hoje, tarefas_hoje, sem_contato, aniversarios, por_estagio, fechados_mes, taxa_conversao: taxa });
  } catch(e) { console.error('Dashboard erro:', e.message); res.status(500).json({ error: e.message }); }
});

// ─── IA: ANALISAR CONVERSA ────────────────────────────────────────
app.post('/api/ia/analisar-conversa', async (req, res) => {
  const { conversa, salvar_lead_id } = req.body;
  if (!conversa) return res.status(400).json({ error: 'Conversa obrigatória' });
  const hoje = new Date();
  const hojeISO = hoje.toISOString().split('T')[0];
  const amanha = new Date(hoje); amanha.setDate(hoje.getDate()+1);
  const amanhaISO = amanha.toISOString().split('T')[0];
  const semana = new Date(hoje); semana.setDate(hoje.getDate()+5);
  const semanaISO = semana.toISOString().split('T')[0];

  const prompt = `Analise esta conversa de vendas de carros. HOJE: ${hojeISO}

CONVERSA:
${conversa}

Seja direto e preciso. Retorne APENAS JSON:
{
  "nome": "nome do cliente ou null",
  "telefone": "número com DDD ou null",
  "carro_interesse": "marca modelo ano ou null",
  "parcela_max": numero_ou_null,
  "tem_troca": true_ou_false,
  "carro_troca": "ou null",
  "temperatura": "quente/morno/frio",
  "resumo": "máximo 2 frases diretas",
  "proximo_passo": "ação específica e curta",
  "proximo_contato": "data YYYY-MM-DD ou null",
  "ultimo_contato": "data YYYY-MM-DD da última mensagem",
  "tarefa_titulo": "ex: Ligar João — Ka 2020",
  "urgencia": "hoje/amanha/essa_semana/sem_urgencia"
}`;

  const txt = await claudeAI(prompt, 500);
  const data = parseJSON(txt);
  if (!data) return res.status(500).json({ error: 'IA não respondeu. Tente novamente.' });

  if (salvar_lead_id) {
    const sets = ["conversa_historico=?","updated_at=datetime('now','localtime')"];
    const vals = [conversa];
    if (data.nome)           { sets.push('nome=?');            vals.push(data.nome); }
    if (data.telefone)       { sets.push('telefone=?');         vals.push(data.telefone.replace(/\D/g,'')); }
    if (data.carro_interesse){ sets.push('carro_interesse=?');  vals.push(data.carro_interesse); }
    if (data.parcela_max)    { sets.push('parcela_max=?');       vals.push(data.parcela_max); }
    if (data.tem_troca !== undefined) { sets.push('tem_troca=?'); vals.push(data.tem_troca?1:0); }
    if (data.carro_troca)    { sets.push('carro_troca=?');       vals.push(data.carro_troca); }
    if (data.temperatura)    { sets.push('temperatura=?');       vals.push(data.temperatura); }
    if (data.proximo_contato){ sets.push('proximo_contato=?');   vals.push(data.proximo_contato); }
    if (data.ultimo_contato) { sets.push('ultimo_contato=?');    vals.push(data.ultimo_contato); }
    if (data.resumo)         { sets.push('ai_insight=?');        vals.push(data.resumo); }
    if (data.proximo_passo)  { sets.push('ai_sugestao=?');       vals.push(data.proximo_passo); }
    vals.push(salvar_lead_id);
    db.prepare(`UPDATE leads SET ${sets.join(',')} WHERE id=?`).run(...vals);
    db.prepare('INSERT INTO anotacoes (lead_id,tipo,conteudo) VALUES (?,?,?)').run(salvar_lead_id,'ia',`🤖 ${data.resumo||'Conversa analisada'}`);
    if (data.tarefa_titulo && data.urgencia !== 'sem_urgencia') {
      const dataVenc = data.proximo_contato || (data.urgencia==='hoje'?hojeISO:data.urgencia==='amanha'?amanhaISO:semanaISO);
      const jaTemTarefa = db.prepare('SELECT id FROM tarefas WHERE lead_id=? AND concluida=0').get(salvar_lead_id);
      if (!jaTemTarefa) db.prepare('INSERT INTO tarefas (lead_id,titulo,tipo,data_vencimento,criada_por_ia) VALUES (?,?,?,?,1)').run(salvar_lead_id,data.tarefa_titulo,'followup',dataVenc);
      data._tarefa_criada = true;
    }
  }
  res.json(data);
});

// ─── IA: LOTE ────────────────────────────────────────────────────
const loteStatus = { rodando: false, total: 0, processados: 0, erros: 0, log: [] };
app.get('/api/ia/lote/status', (req, res) => res.json(loteStatus));

app.post('/api/ia/lote/iniciar', async (req, res) => {
  if (loteStatus.rodando) return res.json({ message: 'Já rodando', status: loteStatus });
  const { modo } = req.body || {};
  const q = modo === 'todos'
    ? "SELECT l.* FROM leads l JOIN estagios e ON l.estagio_id=e.id WHERE e.nome NOT IN ('Comprou ✅','Outro lugar 🔴','Perdido ❌') LIMIT 60"
    : "SELECT l.* FROM leads l JOIN estagios e ON l.estagio_id=e.id WHERE l.conversa_historico IS NOT NULL AND l.conversa_historico!='' AND e.nome NOT IN ('Comprou ✅','Outro lugar 🔴','Perdido ❌') LIMIT 50";
  const leads = db.prepare(q).all();
  if (!leads.length) return res.json({ message: 'Nenhum lead encontrado', total: 0 });
  loteStatus.rodando=true; loteStatus.total=leads.length; loteStatus.processados=0; loteStatus.erros=0; loteStatus.log=[];
  res.json({ message: `Analisando ${leads.length} leads...`, total: leads.length });
  const hoje = new Date().toISOString().split('T')[0];
  const amanha = new Date(); amanha.setDate(amanha.getDate()+1); const amanhaISO = amanha.toISOString().split('T')[0];
  const semana = new Date(); semana.setDate(semana.getDate()+5); const semanaISO = semana.toISOString().split('T')[0];
  (async () => {
    for (const lead of leads) {
      try {
        loteStatus.log.push(`🔄 ${lead.nome}...`);
        const ctx = lead.conversa_historico ? lead.conversa_historico.substring(0,1500) : `Carro:${lead.carro_interesse||'?'} Parcela:${lead.parcela_max||'?'} Temp:${lead.temperatura}`;
        const prompt = `Analise este lead de carros. HOJE:${hoje}\n${ctx}\nJSON: {"temperatura":"quente/morno/frio","resumo":"1 frase","proximo_passo":"ação curta","proximo_contato":"YYYY-MM-DD ou null","tarefa_titulo":"título ou null","urgencia":"hoje/amanha/essa_semana/sem_urgencia"}`;
        const txt = await claudeAI(prompt, 300);
        const data = parseJSON(txt);
        if (data) {
          db.prepare('UPDATE leads SET temperatura=?,ai_insight=?,ai_sugestao=?,proximo_contato=COALESCE(?,proximo_contato) WHERE id=?')
            .run(data.temperatura||lead.temperatura, data.resumo||'', data.proximo_passo||'', data.proximo_contato||null, lead.id);
          if (data.tarefa_titulo && data.urgencia !== 'sem_urgencia') {
            const jaTemTarefa = db.prepare('SELECT id FROM tarefas WHERE lead_id=? AND concluida=0').get(lead.id);
            if (!jaTemTarefa) {
              const dv = data.proximo_contato||(data.urgencia==='hoje'?hoje:data.urgencia==='amanha'?amanhaISO:semanaISO);
              db.prepare('INSERT INTO tarefas (lead_id,titulo,tipo,data_vencimento,criada_por_ia) VALUES (?,?,?,?,1)').run(lead.id,data.tarefa_titulo,'followup',dv);
              loteStatus.log.push(`✅ ${lead.nome}: ${data.temperatura} | 📋 ${data.tarefa_titulo}`);
            } else { loteStatus.log.push(`✅ ${lead.nome}: ${data.temperatura}`); }
          } else { loteStatus.log.push(`✅ ${lead.nome}: ${data.temperatura}`); }
        }
        loteStatus.processados++;
      } catch(e) { loteStatus.erros++; loteStatus.log.push(`❌ ${lead.nome}: ${e.message}`); }
      await new Promise(r => setTimeout(r, 700));
    }
    loteStatus.rodando=false;
    loteStatus.log.push(`🎉 ${loteStatus.processados}/${loteStatus.total} analisados`);
  })();
});

// ─── RELATÓRIO ────────────────────────────────────────────────────
async function gerarRelatorio() {
  if (!ANTHROPIC_KEY) return;
  const total = db.prepare('SELECT COUNT(*) as n FROM leads').get()?.n||0;
  const quentes = db.prepare("SELECT COUNT(*) as n FROM leads WHERE temperatura='quente'").get()?.n||0;
  const fechados = db.prepare("SELECT COUNT(*) as n FROM leads l JOIN estagios e ON l.estagio_id=e.id WHERE e.nome='Comprou ✅'").get()?.n||0;
  const prompt = `Relatório de vendas de carros. Total:${total} Quentes:${quentes} Fechados:${fechados}. Gere resumo motivador com 3 ações prioritárias em português.`;
  const txt = await claudeAI(prompt, 500);
  if (txt) db.prepare('INSERT INTO ai_relatorios (tipo,conteudo) VALUES (?,?)').run('diario',txt);
}
cron.schedule('0 8 * * *', gerarRelatorio);
app.get('/api/ia/relatorio', (req, res) => { const r = db.prepare('SELECT * FROM ai_relatorios ORDER BY created_at DESC LIMIT 1').get(); res.json(r||{conteudo:'Clique em Gerar para criar a análise.'}); });
app.post('/api/ia/relatorio/gerar', async (req, res) => { res.json({message:'Gerando...'}); await gerarRelatorio(); });

// ─── IMPORTAR ────────────────────────────────────────────────────
app.post('/api/leads/importar-excel', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo obrigatório' });
  try {
    const rows = XLSX.utils.sheet_to_json(XLSX.readFile(req.file.path).Sheets[XLSX.readFile(req.file.path).SheetNames[0]], {defval:''});
    fs.unlinkSync(req.file.path);
    const get = (row,keys) => { const rk=Object.keys(row).map(k=>k.toLowerCase()); for(const k of keys){const i=rk.findIndex(r=>r.includes(k));if(i>=0)return Object.values(row)[i];} return ''; };
    const primeiroEstagio = db.prepare('SELECT id FROM estagios ORDER BY posicao ASC LIMIT 1').get();
    let criados=0,duplicados=0,erros=0;
    for (const row of rows) {
      try {
        const tel = String(get(row,['telefone','celular','whatsapp','phone'])||'').replace(/\D/g,'');
        if (!tel||tel.length<8){erros++;continue;}
        const dup = db.prepare("SELECT id FROM leads WHERE replace(replace(telefone,'-',''),' ','') LIKE ?").get('%'+tel.slice(-8));
        if (dup){duplicados++;continue;}
        const nome = String(get(row,['nome','name','cliente'])||'').trim()||'Lead importado';
        const conversa = String(get(row,['conversa','historico','mensagem'])||'').trim()||null;
        db.prepare('INSERT INTO leads (nome,telefone,email,carro_interesse,parcela_max,tem_troca,carro_troca,temperatura,estagio_id,origem,observacoes,conversa_historico,data_nascimento) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(nome,tel,String(get(row,['email'])||''),String(get(row,['carro','veiculo','interesse'])||''),parseFloat(String(get(row,['parcela','valor'])||'').replace(/[^0-9.]/g,''))||null,['sim','yes','1'].includes(String(get(row,['troca'])||'').toLowerCase())?1:0,String(get(row,['carro_troca'])||''),String(get(row,['temperatura','temp'])||'morno'),primeiroEstagio?.id,String(get(row,['origem'])||'Importado'),String(get(row,['obs','observa'])||''),conversa,String(get(row,['nascimento','aniversario'])||'')||null);
        criados++;
      } catch{erros++;}
    }
    res.json({criados,duplicados,erros,total:rows.length});
  } catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/leads/importar-texto', (req, res) => {
  const {dados,origem} = req.body;
  const primeiroEstagio = db.prepare('SELECT id FROM estagios ORDER BY posicao ASC LIMIT 1').get();
  let criados=0,duplicados=0,erros=0;
  for (const linha of (dados||'').split('\n').map(l=>l.trim()).filter(Boolean)) {
    try {
      const p = linha.split(/[,;|\t]/);
      const nome = p.length>1?p[0].trim():'Lead importado';
      const tel = (p.length>1?p[1]:p[0]).trim().replace(/\D/g,'');
      if (!tel||tel.length<8){erros++;continue;}
      const dup = db.prepare("SELECT id FROM leads WHERE replace(replace(telefone,'-',''),' ','') LIKE ?").get('%'+tel.slice(-8));
      if (dup){duplicados++;continue;}
      db.prepare('INSERT INTO leads (nome,telefone,origem,temperatura,estagio_id) VALUES (?,?,?,?,?)').run(nome,tel,origem||'Importado','morno',primeiroEstagio?.id);
      criados++;
    } catch{erros++;}
  }
  res.json({criados,duplicados,erros,total:criados+duplicados+erros});
});

// ─── EXPORTAR ────────────────────────────────────────────────────
app.get('/api/leads/exportar/numeros', (req, res) => {
  const {ids} = req.query;
  const leads = ids ? db.prepare(`SELECT telefone FROM leads WHERE id IN (${ids.split(',').map(()=>'?').join(',')})`).all(...ids.split(',').map(Number)) : db.prepare('SELECT telefone FROM leads').all();
  res.setHeader('Content-Type','text/plain');
  res.send(leads.map(l=>l.telefone.replace(/\D/g,'')).join('\n'));
});

app.get('/api/leads/exportar/excel', (req, res) => {
  const {ids} = req.query;
  const leads = ids ? db.prepare(`SELECT l.*, e.nome as estagio_nome FROM leads l LEFT JOIN estagios e ON l.estagio_id=e.id WHERE l.id IN (${ids.split(',').map(()=>'?').join(',')})`).all(...ids.split(',').map(Number)) : db.prepare('SELECT l.*, e.nome as estagio_nome FROM leads l LEFT JOIN estagios e ON l.estagio_id=e.id ORDER BY l.updated_at DESC').all();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(leads.map(l=>({'Nome':l.nome,'Telefone':l.telefone,'Carro':l.carro_interesse||'','Parcela':l.parcela_max||'','Troca':l.tem_troca?'Sim':'Não','Carro Troca':l.carro_troca||'','Temperatura':l.temperatura,'Estágio':l.estagio_nome||'','Origem':l.origem||'','Último Contato':l.ultimo_contato||'','Próx. Contato':l.proximo_contato||'','Observações':l.observacoes||'','Conversa':l.conversa_historico||'','Criado em':l.created_at||''})));
  ws['!cols']=Array(14).fill({wch:20});
  XLSX.utils.book_append_sheet(wb,ws,'Leads');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="leads_${new Date().toISOString().split('T')[0]}.xlsx"`);
  res.send(buf);
});

app.get('/api/leads/template/excel', (req, res) => {
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.json_to_sheet([{nome:'João Silva',telefone:'48999998888',email:'joao@email.com',carro_interesse:'Ka 2020',parcela_max:700,tem_troca:'sim',carro_troca:'Gol 2018',temperatura:'quente',origem:'Meta Ads',observacoes:'Quer financiar',conversa_historico:'[10:30] João: Oi vi o Ka...',data_nascimento:'1990-05-13'}]);
  ws['!cols']=Array(12).fill({wch:20});
  XLSX.utils.book_append_sheet(wb,ws,'Template');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="template_leads.xlsx"');
  res.send(buf);
});

// ─── CONFIG ───────────────────────────────────────────────────────
const configPath = path.join(__dirname, 'config.json');
const getConfig = () => { try { return JSON.parse(fs.readFileSync(configPath,'utf8')); } catch { return {}; } };
app.get('/api/config', (req,res) => res.json(getConfig()));
app.post('/api/config', (req,res) => { fs.writeFileSync(configPath,JSON.stringify(req.body,null,2)); res.json({ok:true}); });

// ─── PWA ─────────────────────────────────────────────────────────
app.get('/sw.js', (req,res) => { res.setHeader('Content-Type','application/javascript'); res.setHeader('Service-Worker-Allowed','/'); res.sendFile(path.join(__dirname,'frontend','sw.js')); });
app.get('/manifest.json', (req,res) => { res.setHeader('Content-Type','application/manifest+json'); res.sendFile(path.join(__dirname,'frontend','manifest.json')); });

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'frontend','index.html')));

app.listen(PORT, () => {
  console.log(`🚗 aclera.crm na porta ${PORT}`);
  const hoje = new Date().toISOString().split('T')[0];
  const relHoje = db.prepare("SELECT id FROM ai_relatorios WHERE created_at LIKE ? AND tipo='diario'").get(hoje+'%');
  if (!relHoje && ANTHROPIC_KEY) setTimeout(gerarRelatorio, 15000);
});
