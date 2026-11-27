# Agy Remote

**English:** control coding-agent CLIs running on your PC from your Android phone (Node server, Electron shell, Android WebView app). Early stage; contributions welcome.

Controle pelo celular de CLIs de agentes de código que rodam no PC.

- `server/`: servidor Node
- `desktop/`: casca Electron ([instruções](desktop/README.md))
- `android/`: app Android (WebView)

## Segurança / Security

**English:** anyone holding the access token has full control of the PC: the app runs terminal commands, reads any file your user can read, and drives AI agents. LAN access is off by default and uses unencrypted HTTP; never expose the port to the internet.

- **O token dá controle total do PC**: terminal, leitura de arquivos e agentes de IA.
- **Rede**: por padrão o servidor só escuta em `127.0.0.1`. Para o celular, ligue com `"lan": true` no `config.json` ou `AGY_REMOTE_LAN=1` (a variável, se definida, vale mais; `0` desliga) e reinicie. É HTTP sem criptografia e escuta em todas as interfaces IPv4: use só em rede de confiança ou pelo Tailscale, e nunca abra a porta no roteador.
- **Nomes de host**: são aceitos IPs, `localhost`, o nome do PC, `*.ts.net` e os nomes em `"allowedHosts": []` do `config.json`.
- **Pareamento**: o código de 6 dígitos muda a cada pareamento; há limite de 10 tentativas por endereço e 50 no total a cada 10 minutos.
- **Revogar aparelhos**: no app desktop, bandeja → "Revogar aparelhos (gerar novo token)". Com o servidor solto, feche-o e rode `node server/server.js --reset-token`. A revogação vale para todos de uma vez.
- **Permissões das IAs**: "liberar comandos" vem desligado em missões e automações. Desligado **não** é garantia de bloqueio, porque cada CLI aplica as próprias regras e configurações. **No Windows, o Codex roda com `--sandbox danger-full-access` (sem sandbox)** em todos os modos, exceto "Só planejar" (`read-only`): ele pode executar comandos e alterar arquivos fora da pasta do projeto. No OpenCode, o modo escolhido não é repassado à CLI, nem em "Só planejar". A aba Terminal executa comandos direto, em qualquer modo.

Licença MIT.
