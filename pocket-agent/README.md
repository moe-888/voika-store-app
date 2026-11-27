# Pocket Agent

Your own private coding agent. It runs on **your computer**, uses a **free local AI model** through [Ollama](https://ollama.com), and you control it from **your phone** in the browser.

- 💬 Chat with an AI that can read your files, edit code, search, and run commands
- ✅ It asks before writing files or running commands (Allow / Deny / Allow all)
- 📱 A web app built for phones, which you can add to your home screen
- 💾 Chats are saved on your own disk in `~/.pocket-agent/`
- 🔒 Password protected
- 🆓 No subscription, no API key, no cloud. Nothing to install from npm (it has zero dependencies)

## 1. Install (one time)

1. Install **Node.js 18 or newer**: https://nodejs.org
2. Install **Ollama**: https://ollama.com/download
3. Download a model that can use tools. Pick one that fits your computer:

   | Your computer | Command |
   |---|---|
   | 8 GB RAM | `ollama pull qwen2.5-coder:3b` |
   | 16 GB RAM (recommended) | `ollama pull qwen2.5-coder:7b` |
   | 32 GB+ RAM or a good GPU | `ollama pull qwen2.5-coder:14b` or `qwen3:14b` |

   Other models that support tools also work, such as `llama3.1`, `qwen3` and `mistral-nemo`.

4. Get this project:
   ```bash
   git clone https://github.com/<you>/pocket-agent.git
   ```

## 2. Start it

```bash
cd pocket-agent
node server.js ~/path/to/your/project
```

The folder you give it is the **workspace** the agent works in. You can open chats on other folders from the app too.

It prints something like:

```
  On this computer:  http://localhost:8787
  On your phone:     http://192.168.1.20:8787   (same Wi-Fi or Tailscale)
  Password: Xk3...
```

Open the link and enter the password. The password is saved in `~/.pocket-agent/config.json`.

## 3. Use it from your phone anywhere (free)

- **Same Wi-Fi:** open the "On your phone" link.
- **Away from home:** install [Tailscale](https://tailscale.com) (free) on your computer and phone, and sign in to both with the same account. Then open `http://<computer-name>:8787` on your phone. It's private: only your devices can reach it.
- Tip: in your phone's browser choose **Add to Home Screen** so it opens like an app.

⚠️ Don't open port 8787 on your router to the whole internet. Use Tailscale instead.

## Settings

Set these as environment variables before `node server.js`:

| Variable | Default | What it does |
|---|---|---|
| `MODEL` | `qwen2.5-coder:7b` | Default model for new chats |
| `PORT` | `8787` | Port of the web app |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` to allow only this computer |
| `AGENT_PASSWORD` | random, saved | Your own password |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama runs |
| `NUM_CTX` | `16384` | How much text the model remembers (more needs more RAM) |
| `DATA_DIR` | `~/.pocket-agent` | Where chats and settings are stored |

Example (Mac/Linux): `MODEL=qwen3:8b PORT=9000 node server.js ~/code/voika`
Example (Windows PowerShell): `$env:MODEL="qwen3:8b"; node server.js C:\code\voika`

## What the agent can do

| Tool | Asks first? |
|---|---|
| `list_dir`: list a folder | no |
| `read_file`: read a file | no |
| `search`: search text in files | no |
| `write_file`: create or replace a file | **yes** |
| `edit_file`: change part of a file | **yes** |
| `run_command`: run a terminal command (git, npm, tests…) | **yes** |

File tools can't leave the workspace folder. Commands run in the workspace folder, so read them before you press Allow.

## Tips

- Local models are smaller than cloud AIs. Give clear, step-by-step requests ("read src/app.js and fix the login bug").
- If replies are slow, use a smaller model. If they're not good enough, use a bigger one.
- "does not support tools" error: pick another model from the list above.
- Run the tests: `npm test`

## License

MIT
