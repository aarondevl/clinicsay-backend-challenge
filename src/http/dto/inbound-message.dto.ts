import { IsString } from 'class-validator';
import { IsIsoDateTimeWithZone } from '../validation.js';

/**
 * Cuerpo de `POST /webhooks/inbound-messages`. `from` solo se comprueba como
 * texto: un teléfono que no es E.164 no tiene envíos y el mensaje se ignora
 * con 200.
 */
export class InboundMessageDto {
  @IsString()
  messageId!: string;

  @IsString()
  from!: string;

  @IsString()
  text!: string;

  @IsIsoDateTimeWithZone()
  receivedAt!: string;
}
