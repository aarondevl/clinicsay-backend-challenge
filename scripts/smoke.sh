#!/usr/bin/env bash
# Prueba de humo contra el compose levantado (`docker compose up --build -d --wait`):
# reloj de test → clínica → paciente → cita → reloj a la hora de envío → una
# pasada del job → el proveedor tiene el recordatorio con el texto exacto.
#
# Sale con 0 si todo cuadra y con 1 y un mensaje en cuanto algo no cuadra.
# Necesita bash, curl, grep y sed (nada de jq). Se puede repetir sobre la misma
# base: vacía el proveedor, usa un teléfono nuevo en cada ejecución y lanza una
# pasada previa para que lo que dejaran otras pruebas no cuente en `processed`.
#
# Variables: API_URL (por defecto http://localhost:3000) y PROVIDER_URL (por
# defecto http://localhost:4010).
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
PROVIDER_URL="${PROVIDER_URL:-http://localhost:4010}"

# Ejemplo del enunciado: cita el domingo 28/03/2027 a las 10:00 de Madrid, el
# día del cambio de horario → recordatorio el sábado 27/03/2027 a las 10:00 de
# Madrid, que son las 09:00 UTC.
CLOCK_BEFORE='2027-03-20T10:00:00Z'
STARTS_AT='2027-03-28T10:00:00+02:00'
SEND_AT='2027-03-27T09:00:00Z'
CLINIC_NAME='Clínica Humo'
PATIENT_NAME='Ana'
TEXT="Hola ${PATIENT_NAME}, te recordamos tu cita en ${CLINIC_NAME} el 28/03/2027 a las 10:00. Responde SI para confirmar o NO para cancelar."
# E.164 distinto en cada ejecución: +346 y 8 cifras al azar (30 bits).
PHONE="+346$(printf '%08d' $((((RANDOM << 15) | RANDOM) % 100000000)))"

STATUS=''
BODY=''

fail() {
  echo "smoke: FALLO: $*" >&2
  exit 1
}

step() {
  echo "smoke: $*"
}

# request MÉTODO URL [JSON]: deja el código HTTP en STATUS y el cuerpo en BODY.
request() {
  local method=$1 url=$2 data=${3:-} out
  local args=(-sS -X "$method" -w '\n%{http_code}')
  if [ -n "$data" ]; then
    args+=(-H 'content-type: application/json' --data "$data")
  fi
  out=$(curl "${args[@]}" "$url") || fail "no se pudo llamar a $method $url (¿está levantado el compose?)"
  STATUS=${out##*$'\n'}
  BODY=${out%$'\n'*}
}

# expect_status CÓDIGO QUÉ: falla si la última petición no respondió CÓDIGO.
expect_status() {
  [ "$STATUS" = "$1" ] || fail "$2: se esperaba $1 y llegó $STATUS: $BODY"
}

# expect_body_contains TEXTO QUÉ: falla si el último cuerpo no contiene TEXTO.
expect_body_contains() {
  grep -qF -- "$1" <<<"$BODY" || fail "$2: falta $1 en $BODY"
}

# id_of: el `id` con el que empiezan las respuestas de clínica, paciente y cita.
id_of() {
  sed -nE 's/^\{"id":"([^"]+)".*/\1/p' <<<"$BODY"
}

set_clock() {
  request PUT "$API_URL/test/clock" "{\"now\":\"$1\"}"
  expect_status 204 "PUT /test/clock $1"
}

step "api en $API_URL, proveedor en $PROVIDER_URL, teléfono $PHONE"

request GET "$API_URL/health"
expect_status 200 'GET /health'

request POST "$PROVIDER_URL/admin/reset"
expect_status 204 'POST /admin/reset del proveedor'

# Pasada previa a la hora de envío: trata los pendientes que hubieran dejado
# otras pruebas en esta base, para que la pasada de abajo solo vea la cita nueva.
set_clock "$SEND_AT"
request POST "$API_URL/jobs/reminders/run"
expect_status 200 'pasada previa'

set_clock "$CLOCK_BEFORE"

request POST "$API_URL/clinics" "{\"name\":\"$CLINIC_NAME\",\"timezone\":\"Europe/Madrid\"}"
expect_status 201 'POST /clinics'
CLINIC_ID=$(id_of)
[ -n "$CLINIC_ID" ] || fail "POST /clinics sin id: $BODY"

request POST "$API_URL/patients" "{\"clinicId\":\"$CLINIC_ID\",\"name\":\"$PATIENT_NAME\",\"phone\":\"$PHONE\",\"acceptsReminders\":true}"
expect_status 201 'POST /patients'
PATIENT_ID=$(id_of)
[ -n "$PATIENT_ID" ] || fail "POST /patients sin id: $BODY"

request POST "$API_URL/appointments" "{\"clinicId\":\"$CLINIC_ID\",\"patientId\":\"$PATIENT_ID\",\"startsAt\":\"$STARTS_AT\"}"
expect_status 201 'POST /appointments'
APPOINTMENT_ID=$(id_of)
[ -n "$APPOINTMENT_ID" ] || fail "POST /appointments sin id: $BODY"
expect_body_contains "\"scheduledFor\":\"$SEND_AT\",\"status\":\"pending\"" 'hora de envío del recordatorio'
REMINDER_ID=$(sed -nE 's/.*"reminders":\[\{"id":"([^"]+)".*/\1/p' <<<"$BODY")
[ -n "$REMINDER_ID" ] || fail "POST /appointments sin recordatorio: $BODY"
step "cita $APPOINTMENT_ID con el recordatorio $REMINDER_ID para $SEND_AT"

set_clock "$SEND_AT"
request POST "$API_URL/jobs/reminders/run"
expect_status 200 'POST /jobs/reminders/run'
[ "$BODY" = '{"processed":1}' ] || fail "POST /jobs/reminders/run: se esperaba {\"processed\":1} y llegó $BODY"
step "pasada: $BODY"

# El `+` del teléfono va codificado: en una query sin codificar es un espacio.
request GET "$PROVIDER_URL/admin/messages?to=%2B${PHONE#+}"
expect_status 200 'GET /admin/messages del proveedor'
MESSAGES=$(grep -o '"idempotencyKey"' <<<"$BODY" | wc -l || true)
[ "$MESSAGES" -eq 1 ] || fail "el proveedor tiene $MESSAGES mensajes para $PHONE y se esperaba 1: $BODY"
expect_body_contains "\"text\":\"$TEXT\"" 'texto del mensaje'
expect_body_contains "\"idempotencyKey\":\"$REMINDER_ID\"" 'Idempotency-Key = id del recordatorio'

request GET "$API_URL/appointments/$APPOINTMENT_ID"
expect_status 200 "GET /appointments/$APPOINTMENT_ID"
expect_body_contains "\"status\":\"sent\",\"attempts\":1,\"sentAt\":\"$SEND_AT\"" 'recordatorio enviado'

step "OK: el recordatorio salió a las $SEND_AT con el texto exacto"
