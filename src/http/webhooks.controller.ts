import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { HandleInboundMessage } from '../application/inbound/handle-inbound-message.js';
import { InboundMessageDto } from './dto/inbound-message.dto.js';
import { parseIsoDateTimeWithZone } from './validation.js';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly handleInboundMessage: HandleInboundMessage) {}

  /**
   * `POST /webhooks/inbound-messages` → 200 sin cuerpo, también si el mensaje
   * se ignora: un error haría que el proveedor lo reenviara. Un cuerpo fuera
   * del esquema es 400 (lo rechaza el `ValidationPipe` antes de llegar aquí).
   * @throws {ServiceUnavailableError} (503) si la base no responde.
   */
  @Post('inbound-messages')
  @HttpCode(200)
  async receive(@Body() body: InboundMessageDto): Promise<void> {
    await this.handleInboundMessage.execute({
      messageId: body.messageId,
      from: body.from,
      text: body.text,
      receivedAt: parseIsoDateTimeWithZone(body.receivedAt),
    });
  }
}
