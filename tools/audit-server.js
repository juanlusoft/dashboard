/**
 * HomePiNAS Audit Dashboard — Tiny dev server
 * Sirve la página de auditoría con chat Claude integrado.
 *
 * Uso:
 *   ANTHROPIC_API_KEY=sk-ant-... node tools/audit-server.js
 *   Luego abre http://localhost:3001
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const AUDIT_FILE = path.join(__dirname, '..', 'AUDIT.md');
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Serve AUDIT.md content
app.get('/content', (req, res) => {
    try {
        const content = fs.readFileSync(AUDIT_FILE, 'utf8');
        res.json({ content });
    } catch (e) {
        res.status(500).json({ error: 'No se pudo leer AUDIT.md: ' + e.message });
    }
});

// Chat with Claude (streaming SSE)
app.post('/chat', async (req, res) => {
    if (!API_KEY) {
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY no está configurada. Ejecuta: ANTHROPIC_API_KEY=sk-ant-... node tools/audit-server.js' });
    }

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages requerido' });
    }

    let auditContent = '';
    try { auditContent = fs.readFileSync(AUDIT_FILE, 'utf8'); } catch {}

    const systemPrompt = `Eres Claude Code, asistente técnico del proyecto HomePiNAS v2 (dashboard NAS para Raspberry Pi CM5).
El proyecto está en GitHub: juanlusoft/dashboard.

Estado actual del plan de auditoría:
\`\`\`
${auditContent}
\`\`\`

Contexto técnico:
- Stack: Node.js/Express backend, vanilla JS frontend, SQLite sesiones
- Hardware: Raspberry Pi CM5, fan controller EMC2305 (I2C), power monitor INA238
- Features: Docker, Samba, WireGuard, Syncthing, SnapRAID, mergerfs, Active Directory
- Versión actual: v2.13.26

Responde siempre en español. Sé conciso y técnico.`;

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 2048,
                stream: true,
                system: systemPrompt,
                messages
            })
        });

        if (!response.ok) {
            const err = await response.json();
            res.write(`data: ${JSON.stringify({ error: err.error?.message || 'Error API' })}\n\n`);
            return res.end();
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                        res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
                    }
                } catch {}
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (e) {
        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        res.end();
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`\n🏠 HomePiNAS Audit Dashboard`);
    console.log(`   http://localhost:${PORT}\n`);
    if (!API_KEY) {
        console.warn('⚠️  ANTHROPIC_API_KEY no configurada — el chat no funcionará.');
        console.warn('   Ejecuta: ANTHROPIC_API_KEY=sk-ant-... node tools/audit-server.js\n');
    }
});
