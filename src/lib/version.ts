// src/lib/version.ts
//
// Fonte única da versão exibida na interface (rodapé da Sidebar). Separada
// de package.json#version de propósito: aquele campo é metadado de
// pacote/build (npm), não necessariamente o que se quer comunicar ao
// usuário final na tela — mantê-los desacoplados evita que um bump de
// versão de dependências/build force uma mudança no que aparece na UI.
export const APP_VERSION = '1.0.1'
export const APP_COPYRIGHT_YEAR = 2026
