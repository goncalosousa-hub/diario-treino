# Diário de Treino

Web app para registar o plano Push · Pull · Legs · Arms: cargas e reps por série, o que fizeste na última vez, quando subir o peso, temporizador de descanso, histórico por semana e progresso por exercício.

## Instalar no iPhone

1. Abre https://goncalosousa-hub.github.io/diario-treino/ no Safari.
2. Toca em **Partilhar** e depois em **Adicionar ao ecrã principal**.
3. Abre a app pelo ícone **Treino**. Funciona sem rede depois da primeira abertura.

## Dados

Os treinos ficam guardados só no aparelho (armazenamento local do navegador). Em **Histórico → Cópia de segurança** podes exportar uma cópia (JSON) ou um CSV e importar cópias ou códigos de importação.

## Ficheiros

- `index.html`: a app inteira (HTML, CSS e JavaScript, sem dependências).
- `sw.js`: guarda a app no aparelho para abrir sem rede. Ao alterar ficheiros, sobe `VERSION`.
- `manifest.webmanifest` e `icons/`: nome, ícone e modo de ecrã inteiro.
- `fonts/`: Barlow e Barlow Condensed (SIL Open Font License, ver `fonts/OFL.txt`).
