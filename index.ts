import "dotenv/config";
import { SecureClient } from "tinfoil";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as readline from "readline/promises";

// ── Config from .env ──────────────────────────────────────────────
const apiKey = process.env.PPQ_API_KEY;
const model = process.env.MODEL || "private/kimi-k2-5";
let chatLogsEnabled = process.env.CHAT_LOGS?.toLowerCase() === "true";
let logPassword = process.env.LOG_PASSWORD || "";
const verbose = process.env.VERBOSE?.toLowerCase() === "true";

function log(...args: unknown[]): void {
  if (verbose) console.log("[VERBOSE]", ...args);
}

if (!apiKey || apiKey === "paste-your-ppq-api-key-here") {
  console.error(
    "\n❌  Missing API key!\n" +
    "    Open the .env file and replace the placeholder with your ppq.ai API key.\n" +
    '    It should look like: PPQ_API_KEY=sk-...\n'
  );
  process.exit(1);
}

// ── Model ID mapping ─────────────────────────────────────────────
// ppq.ai uses "private/..." externally but the enclave expects the raw name
const enclaveModel = model.startsWith("private/") ? model.slice(8) : model;

if (!enclaveModel || enclaveModel.trim() === "") {
  console.error(`\n❌  Invalid model specified: "${model}"\n`);
  process.exit(1);
}

// ── Chat log helpers ──────────────────────────────────────────────
const LOGS_DIR = path.join(import.meta.dirname ?? ".", "logs");

function ensureLogsDir(): void {
  if (chatLogsEnabled && !fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `chat_${date}.json`);
}

interface LogEntry {
  timestamp: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  response: string | null;
  tokens: number | null;
  error?: string;
}

// ── Encryption helpers ────────────────────────────────────────────
const ALGO = "aes-256-gcm";

function encryptLog(text: string): Buffer {
  if (!logPassword) return Buffer.from(text, "utf-8"); // fallback if plaintext
  const iv = crypto.randomBytes(12);
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(logPassword, salt, 600000, 32, "sha256");
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const magic = Buffer.from("ENC1"); // Prefix to identify encrypted files
  return Buffer.concat([magic, salt, iv, authTag, encrypted]);
}

export function decryptLog(buffer: Buffer): string {
  const magic = buffer.subarray(0, 4);
  if (magic.toString("utf-8") !== "ENC1") {
    // If it doesn't have the magic header, assume it's an old plaintext log
    return buffer.toString("utf-8");
  }
  if (!logPassword) {
    throw new Error("Log file is encrypted, but no log password was provided!");
  }
  try {
    // Minimum size: 4 (magic) + 16 (salt) + 12 (iv) + 16 (authTag) = 48 bytes
    if (buffer.length < 48) {
      throw new Error("Buffer too short to be a valid encrypted log.");
    }
    const salt = buffer.subarray(4, 20);
    const iv = buffer.subarray(20, 32);
    const authTag = buffer.subarray(32, 48);
    const encrypted = buffer.subarray(48);

    const key = crypto.pbkdf2Sync(logPassword, salt, 600000, 32, "sha256");
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
  } catch (err) {
    throw new Error("Failed to decrypt log file. Incorrect password or corrupted file.");
  }
}

function writeLog(entry: LogEntry): void {
  if (!chatLogsEnabled) return;
  ensureLogsDir();
  const text = JSON.stringify(entry, null, 2);
  const encrypted = encryptLog(text);
  fs.writeFileSync(getLogFilePath(), encrypted);
}

// ── Verbose error dumper ──────────────────────────────────────────
function dumpError(error: unknown, depth = 0): void {
  if (!verbose) return;
  const indent = "  ".repeat(depth);

  if (error instanceof Error) {
    console.error(`${indent}[ERROR] Name: ${error.name}`);
    console.error(`${indent}[ERROR] Message: ${error.message}`);
    if (error.stack) {
      console.error(`${indent}[ERROR] Stack:`);
      for (const line of error.stack.split("\n").slice(1, 8)) {
        console.error(`${indent}  ${line.trim()}`);
      }
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause) {
      console.error(`${indent}[ERROR] Caused by:`);
      dumpError(cause, depth + 1);
    }
    const anyErr = error as unknown as Record<string, unknown>;
    if (anyErr.status) console.error(`${indent}[ERROR] HTTP Status: ${anyErr.status}`);
    if (anyErr.code) console.error(`${indent}[ERROR] Code: ${anyErr.code}`);
    if (anyErr.type) console.error(`${indent}[ERROR] Type: ${anyErr.type}`);
    if (anyErr.error) {
      console.error(`${indent}[ERROR] Body:`);
      console.error(`${indent}   ${JSON.stringify(anyErr.error, null, 2)}`);
    }
  } else {
    console.error(`${indent}[ERROR] Raw:`, error);
  }
}

// ── Summarize history ─────────────────────────────────────────────
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "private/llama3-3-70b";
const summaryEnclaveModel = SUMMARY_MODEL.startsWith("private/") ? SUMMARY_MODEL.slice("private/".length) : SUMMARY_MODEL;
const summarySystemPrompt =
  process.env.SUMMARY_SYSTEM_PROMPT ||
  "You are a summarization assistant. Produce a concise but complete summary of the conversation below, preserving all important facts, decisions, and context. Write in third person.";
const KEEP_RECENT = 10; // 5 user + 5 assistant

interface SummarizeResult {
  summary: string;
  newMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  condensedCount: number;
}

async function summarizeHistory(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<SummarizeResult | null> {
  const conversation = messages.slice(1); // skip system prompt

  if (conversation.length <= KEEP_RECENT) {
    console.log(`\n   ℹ️  Not enough history to summarize (need more than ${KEEP_RECENT} messages).`);
    return null;
  }

  const toSummarize = conversation.slice(0, conversation.length - KEEP_RECENT);
  const toKeep = conversation.slice(conversation.length - KEEP_RECENT);

  const summaryRequest = [
    { role: "system" as const, content: summarySystemPrompt },
    {
      role: "user" as const,
      content:
        "Summarize the following conversation:\n\n" +
        toSummarize
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
          .join("\n\n"),
    },
  ];

  console.log(`\n⏳  Summarizing ${toSummarize.length} older messages via ${SUMMARY_MODEL}...`);

  const endpoint = `${API_BASE}/private/v1/chat/completions`;
  const body = JSON.stringify({
    model: summaryEnclaveModel,
    messages: summaryRequest,
    temperature: 0.3,
    max_tokens: 2000,
  });

  const response = await client.fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Private-Model": SUMMARY_MODEL,
      "x-query-source": "api",
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText}`);
  }

  const completion = await response.json();
  const summary = completion.choices?.[0]?.message?.content ?? null;

  if (!summary) throw new Error("No summary content received from model.");

  return {
    summary,
    condensedCount: toSummarize.length,
    newMessages: [
      messages[0], // original system prompt
      { role: "system" as const, content: `[Conversation summary up to this point]\n${summary.trim()}` },
      ...toKeep,
    ],
  };
}

// ── Create the SecureClient ───────────────────────────────────────
// ZERO-TRUST CONFIGURATION:
//   - enclaveURL: The actual hardware enclave we encrypt for. The SDK will
//     fetch the HPKE public key and attestation report DIRECTLY from this URL.
//     ppq.ai is completely cut out of the security handshake.
//   - baseURL: The proxy (ppq.ai). The SDK sends the fully encrypted payload
//     here. ppq.ai forwards it to the enclave, but cannot read or tamper
//     with the encryption keys.
const API_BASE = "https://api.ppq.ai";
const ENCLAVE = "https://router.inf6.tinfoil.sh";

log("Initializing SecureClient...");
log(`  baseURL:              ${API_BASE}/private/`);
log(`  enclaveURL:           ${ENCLAVE}`);
log(`  model:                ${model} → enclave: ${enclaveModel}`);

const client = new SecureClient({
  baseURL: `${API_BASE}/private/`,
  enclaveURL: ENCLAVE,
  transport: "ehbp",
});

log("SecureClient created, performing attestation...");

const systemPrompt = process.env.SYSTEM_PROMPT || "You are a helpful, concise assistant. Keep responses under 100 words.";

// ── Interactive Chat Loop ─────────────────────────────────────────

async function main() {
  console.log("🔒  Tinfoil E2E Encrypted Proxy");
  console.log(`   Model:       ${model}`);
  console.log("   Proxy:       ppq.ai");
  console.log("   Encryption:  EHBP (HPKE RFC 9180)");
  console.log("   Attestation: Hardware (AMD SEV-SNP)");
  console.log(`   Chat logs:   ${chatLogsEnabled ? "ON → ./logs/" : "OFF"}`);
  if (verbose) console.log("   Verbose:     ON");
  console.log("─".repeat(50));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const historyFile = process.argv[2];

  if (historyFile !== "--encrypt" && (chatLogsEnabled || historyFile) && !logPassword) {
    logPassword = await rl.question("🔑 Enter a password for local log encryption (leave blank to store logs in plaintext): ");
    if (!logPassword && chatLogsEnabled) {
      console.log("   ⚠️  Warning: Logs will be saved in plaintext.");
    }
  }

  try {
    process.stdout.write("⏳  Verifying enclave... ");
    await client.ready();
    console.log("Verified ✓\n");
  } catch (err: any) {
    console.log("Failed ❌\n");
    console.error(`Attestation failed: ${err.message}`);
    process.exit(1);
  }

  // Initialize conversation history
  let messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Try to load history from an argument like `npm start ./logs/chat_...json`
  if (historyFile && historyFile !== "--encrypt") {
    try {
      const p = path.resolve(historyFile);
      if (fs.existsSync(p)) {
        console.log(`\n📂 Loading conversation history from: ${historyFile}`);
        const fileBuffer = fs.readFileSync(p); // Read as raw Buffer
        
        if (fileBuffer.length > 0) {
          const content = decryptLog(fileBuffer); // Decrypt (or passthrough if plaintext)
          
          let parsedLog;
          try {
            // Try parsing as the new single-state JSON format
            parsedLog = JSON.parse(content);
          } catch {
            // Fallback for legacy append-only .jsonl format
            const lines = content.trim().split("\n");
            parsedLog = JSON.parse(lines[lines.length - 1]);
          }
          
          if (parsedLog.messages && Array.isArray(parsedLog.messages)) {
            messages = parsedLog.messages;
            console.log(`   Restored ${messages.length} messages.\n`);
          } else {
            console.warn(`⚠️  Could not parse messages array from JSON. Starting fresh.`);
          }
        }
      } else {
        console.warn(`\n⚠️  History file not found: ${historyFile}. Starting fresh.`);
      }
    } catch (err: any) {
      console.warn(`\n⚠️  Failed to load history file: ${err.message}. Starting fresh.`);
    }
  }

  console.log("💬  Encrypted chat started. Type your message below.");
  console.log("   (Type 'exit' or 'quit' to end the session)");
  console.log("   (Type '/summarize' to compress older history via llama3-3-70b)\n");

  while (true) {
    const input = await rl.question("You: ");
    const trimmedInput = input.trim();

    if (!trimmedInput) continue;
    if (trimmedInput.toLowerCase() === "exit" || trimmedInput.toLowerCase() === "quit") {
      console.log("\nClosing encrypted session. Goodbye!");
      break;
    }

    if (trimmedInput === "/summarize") {
      try {
        const result = await summarizeHistory(messages);
        if (result) {
          console.log("\n📝  Summary preview:\n");
          console.log(result.summary.trim());
          console.log("\n" + "─".repeat(50));
          const answer = await rl.question("Apply summary and replace older history? [y/N]: ");
          if (answer.trim().toLowerCase() === "y") {
            messages = result.newMessages;
            console.log(`✅  Condensed ${result.condensedCount} messages → 1 summary message.\n`);
            writeLog({
              timestamp: new Date().toISOString(),
              model: SUMMARY_MODEL,
              messages,
              response: "[Summary applied]",
              tokens: null,
            });
          } else {
            console.log("   ↩️  Summarization cancelled. History unchanged.\n");
          }
        }
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`\n❌  Summarization failed: ${errMsg}`);
        if (verbose) dumpError(error);
      }
      continue;
    }

    // Add user message to history
    messages.push({ role: "user", content: trimmedInput });

    try {
      if (verbose) console.log("\n[VERBOSE] Encrypting and sending request...");

      const endpoint = `${API_BASE}/private/v1/chat/completions`;
      const body = JSON.stringify({
        model: enclaveModel,
        messages: messages,
        temperature: 1,
        max_tokens: 10000,
      });

      const response = await client.fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Private-Model": model,
          "x-query-source": "api",
        },
        body: body,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      const completion = await response.json();

      const message = completion.choices?.[0]?.message;
      const reply = message?.content ?? null;
      const reasoning = message?.reasoning ?? null;

      const fullResponseText = [reasoning, reply].filter(Boolean).join("\n\n");

      if (reply || reasoning) {
        console.log("\n🤖  Enclave:");
        if (reasoning) {
          console.log(`\x1b[90m🤔 Reasoning:\n${reasoning.trim()}\x1b[0m\n`); // Dim text for reasoning
        }
        if (reply) {
          console.log(reply.trim());
        }
        console.log("\n" + "─".repeat(50));

        // Add assistant response to history
        messages.push({ role: "assistant", content: fullResponseText });

        writeLog({
          timestamp: new Date().toISOString(),
          model: completion.model ?? model,
          messages,
          response: fullResponseText,
          tokens: completion.usage?.total_tokens ?? null,
        });

      } else {
        console.error("⚠️  No response content received from the model.");
      }

    } catch (error: unknown) {
      console.error("\n❌  Request failed:");
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`   ${errMsg}`);
      if (verbose) dumpError(error);

      // Remove the last user message from history so they can try again
      messages.pop();
    }
  }

  rl.close();
}

async function migrateLogs() {
  console.log("🔒  Tinfoil Log Encryption Tool");
  ensureLogsDir();
  
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.json') || f.endsWith('.jsonl'));
  if (files.length === 0) {
    console.log("No logs found to encrypt.");
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  if (!logPassword) {
    logPassword = await rl.question("🔑 Enter a new password to encrypt all plaintext logs: ");
    if (!logPassword) {
      console.log("❌ Migration cancelled: A password is required to encrypt logs.");
      rl.close();
      return;
    }
  }

  let migratedCount = 0;
  for (const file of files) {
    const p = path.join(LOGS_DIR, file);
    const buffer = fs.readFileSync(p);
    
    // Check magic bytes
    if (buffer.length >= 4 && buffer.subarray(0, 4).toString("utf-8") === "ENC1") {
      console.log(`   ⏭️  Skipping ${file} (Already encrypted)`);
      continue;
    }

    try {
      const content = buffer.toString("utf-8");
      if (!content.trim()) continue;

      // Extract the last line if it's JSONL, or parse entire thing if JSON
      let parsedLog;
      try {
        parsedLog = JSON.parse(content);
      } catch {
        const lines = content.trim().split("\n");
        parsedLog = JSON.parse(lines[lines.length - 1]);
      }

      const text = JSON.stringify(parsedLog, null, 2);
      const encrypted = encryptLog(text);
      
      const newPath = p.replace(/\.jsonl$/, '.json');
      fs.writeFileSync(newPath, encrypted);
      
      if (p !== newPath) {
        fs.unlinkSync(p); // Remove legacy .jsonl file
      }

      console.log(`   ✅ Encrypted ${file} -> ${path.basename(newPath)}`);
      migratedCount++;
    } catch (err: any) {
      console.error(`   ❌ Failed to encrypt ${file}: ${err.message}`);
    }
  }

  console.log(`\n🎉 Migration complete. Encrypted ${migratedCount} files.`);
  rl.close();
}

// ── Application Entry ─────────────────────────────────────────────
if (process.argv[2] === "--encrypt") {
  migrateLogs();
} else {
  main();
}
