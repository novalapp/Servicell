# Prueba del Webhook

## Requisitos previos

1. Servidor ejecutándose: `npm start`
2. Variables de entorno configuradas en `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `META_VERIFY_TOKEN`
3. Servicell ya insertado en la tabla `clients` (ejecutar el seed.sql en Supabase)

## 1. Verificar conexión básica

```bash
curl http://localhost:3000/health
```

Deberías ver:
```json
{ "status": "ok" }
```

## 2. Verificar token del webhook (GET)

```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=tu_token&hub.challenge=test_challenge"
```

Si el token es correcto, recibirás:
```
test_challenge
```

## 3. Probar webhook de WhatsApp

Guarda este payload en un archivo `whatsapp_test.json`:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "123456789",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "5491234567890",
              "phone_number_id": "102345678901234"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Juan Pérez"
                },
                "wa_id": "5491234567890"
              }
            ],
            "messages": [
              {
                "from": "5491234567890",
                "id": "wamid.test123",
                "timestamp": "1234567890",
                "type": "text",
                "text": {
                  "body": "Hola, necesito ayuda"
                }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

Envía el mensaje:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d @whatsapp_test.json
```

Deberías recibir:
```json
{
  "received": true,
  "result": {
    "success": true,
    "contactId": "...",
    "conversationId": "...",
    "messageId": "..."
  }
}
```

## 4. Probar webhook de Instagram

Guarda este payload en un archivo `instagram_test.json`:

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "123456789",
      "messaging": [
        {
          "sender": {
            "id": "instagram_user_123"
          },
          "recipient": {
            "id": "instagram_business_123"
          },
          "timestamp": 1234567890,
          "message": {
            "mid": "instagram_msg_123",
            "text": "Hola desde Instagram"
          }
        }
      ]
    }
  ]
}
```

Envía el mensaje:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d @instagram_test.json
```

## 5. Verificar datos en Supabase

Después de enviar los mensajes, revisa en Supabase:

1. **contacts** — Debería haber un nuevo contacto con:
   - `channel`: "whatsapp" o "instagram"
   - `external_id`: El ID del remitente
   - `name`: El nombre del contacto

2. **conversations** — Debería haber una nueva conversación:
   - `client_id`: ID de Servicell
   - `contact_id`: ID del contacto creado
   - `channel`: El canal usado
   - `status`: "active"

3. **messages** — Debería haber un nuevo mensaje:
   - `conversation_id`: ID de la conversación
   - `content`: El texto del mensaje
   - `role`: "user"
   - `channel`: El canal usado

## Notas

- Cada llamada POST crea un nuevo contacto si no existe (basado en channel + external_id)
- Si el contacto ya existe, reutiliza su ID
- Las conversaciones se crean como "active" automáticamente
- Los timestamps se convierten de segundos Unix a ISO format
