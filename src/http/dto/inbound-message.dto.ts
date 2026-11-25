import { IsString } from 'class-validator';
import {
  IsIsoDateTimeWithZone,
  IsStorableText,
  MAX_TEXT_LENGTH,
} from '../validation.js';

/**
 * Cuerpo de `POST /webhooks/inbound-messages`. `from` no se valida como
 * E.164: un teléfono que no lo es no tiene envíos y el mensaje se ignora con
 * 200. `messageId` y `from` llegan a Postgres y pasan por `@IsStorableText()`;
 * `text` no se guarda ni se consulta, así que un NUL ahí se ignora con 200
 * como cualquier otro texto.
 */
export class InboundMessageDto {
  @IsStorableText(MAX_TEXT_LENGTH.messageId)
  messageId!: string;

  @IsStorableText(MAX_TEXT_LENGTH.phone)
  from!: string;

  @IsString()
  text!: string;

  @IsIsoDateTimeWithZone()
  receivedAt!: string;
}
