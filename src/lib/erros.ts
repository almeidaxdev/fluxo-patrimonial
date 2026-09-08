// src/lib/erros.ts
export class ErroNegocio extends Error {
  status: number
  constructor(message: string, status: number = 409) {
    super(message)
    this.status = status
  }
}
