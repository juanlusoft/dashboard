/**
 * HomePiNAS Audit Dashboard — Tiny dev server
 * Usa el CLI de Claude Code como proxy — no necesita API key.
 *
 * Uso:
 *   node tools/audit-server.js
 *   Luego abre http://localhost:3001
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const AUDIT_FILE = path.join(__dirname, '..', 'AUDIT.md');
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/jlu/.local/bin/claude';

// Serve AUDIT.md content
app.get('/content', (req, res) => {
    try {
        const content = fs.readFileSync(AUDIT_FILE, 'utf8');
        res.json({ content });
    } catch (e) {
        res.status(500).json({ error: 'No se pudo leer AUDIT.md: ' + e.message });
    }
});

// Chat via Claude Code CLI (SSE)
app.post('/chat', (req, res) => {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages requerido' });
    }

    let auditContent = '';
    try { auditContent = fs.readFileSync(AUDIT_FILE, 'utf8'); } catch {}

    const systemContext = `Eres un asistente general con contexto del proyecto HomePiNAS v2.
Puedes responder cualquier pregunta — técnica, general, búsquedas web, etc.
Cuando sea relevante, ten en cuenta el siguiente contexto del proyecto:

Proyecto: HomePiNAS v2 (dashboard NAS para Raspberry Pi CM5) — GitHub: juanlusoft/dashboard
Stack: Node.js/Express backend, vanilla JS frontend, SQLite sesiones
Hardware: Raspberry Pi CM5, fan controller EMC2305 (I2C), power monitor INA238
Features: Docker, Samba, WireGuard, Syncthing, SnapRAID, mergerfs, Active Directory
Versión actual: v2.13.31

Plan de auditoría:
${auditContent}

Responde en español. Sé conciso.`;

    // Build conversation as text for context
    const historyText = messages.slice(0, -1).map(m =>
        `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`
    ).join('\n\n');

    const lastMessage = messages[messages.length - 1];
    const fullPrompt = historyText
        ? `${historyText}\n\nUsuario: ${lastMessage.content}`
        : lastMessage.content;

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let output = '';
    let errOutput = '';

    // Include system context inline in the prompt (avoids arg length issues)
    const promptWithContext = `<context>\n${systemContext}\n</context>\n\n${fullPrompt}`;

    const claude = spawn(CLAUDE_BIN, [
        '--print',
        '--allowedTools', 'WebSearch,WebFetch',
        '--output-format', 'json'
    ], {
        env: { ...process.env, HOME: process.env.HOME },
        cwd: path.join(__dirname, '..')
    });

    claude.stdin.write(promptWithContext);
    claude.stdin.end();

    claude.stdout.on('data', (chunk) => { output += chunk.toString(); });
    claude.stderr.on('data', (chunk) => { errOutput += chunk.toString(); });

    claude.on('close', (code) => {
        try {
            const parsed = JSON.parse(output);
            if (parsed.result) {
                // Stream word by word for a typing effect
                const words = parsed.result.split(/(\s+)/);
                let i = 0;
                const interval = setInterval(() => {
                    if (i >= words.length) {
                        clearInterval(interval);
                        res.write('data: [DONE]\n\n');
                        res.end();
                        return;
                    }
                    res.write(`data: ${JSON.stringify({ text: words[i] })}\n\n`);
                    i++;
                }, 10);
            } else {
                const msg = parsed.error || errOutput || `Código de salida: ${code}`;
                res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        } catch (e) {
            // Fallback: send raw output if not JSON
            if (output.trim()) {
                res.write(`data: ${JSON.stringify({ text: output.trim() })}\n\n`);
            } else {
                res.write(`data: ${JSON.stringify({ error: errOutput || e.message })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });

    claude.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ error: 'CLI no encontrado: ' + err.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });

    res.on('close', () => claude.kill());
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`\n🏠 HomePiNAS Audit Dashboard`);
    console.log(`   http://localhost:${PORT}\n`);
    console.log(`   Usando Claude CLI: ${CLAUDE_BIN}\n`);
});
