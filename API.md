# Contrato para el frontend

Base URL: origen del backend, sin prefijo `/api`. Enviar JSON, `Content-Type: application/json`, y para rutas autenticadas `Authorization: Bearer <supabase access_token>`.

## Rutas

| Método | Ruta | Acceso / respuesta |
|---|---|---|
| GET | `/health` | Público, liveness |
| GET | `/health/ready` | Público, conexión DB |
| GET | `/me` | Autenticado → `{id,role,name,email}` |
| GET | `/courses?offset=0&includeArchived=false` | Profesor → array de cursos activos, `class_count`; `includeArchived=true` incluye el historial de cursos archivados |
| POST | `/courses` | Profesor, `{name}` → curso |
| GET | `/courses/:id/classes?offset=0` | Dueño → clases incluyendo archivadas, `session_id`, `session_status`, `present_count` |
| POST | `/attendance-sessions` | Profesor, cuerpo abajo → clase y sesión nuevas |
| GET | `/attendance-sessions/:id` | Dueño → sesión, nombres, `effective_status`, `present_count`, `server_time` |
| GET | `/attendance-sessions/:id/qr` | Dueño → QR actual |
| POST | `/attendance-sessions/:id/close` | Dueño → sesión cerrada, idempotente |
| POST | `/attendance/check-in/start` | Público, `{qrToken}` → intento temporal |
| POST | `/attendance/check-in/confirm` | Autenticado, `{attemptId,attemptSecret}` → resultado |
| GET | `/attendance-sessions/:id/attendance?offset=0` | Dueño → array con nombre, email y registros PRESENT/VOIDED |
| GET | `/students?q=texto&offset=0` | Profesor → perfiles existentes, mínimo 2 caracteres |
| POST | `/attendance-sessions/:id/attendance/manual` | Dueño, `{userId}` → resultado |
| POST | `/attendance/:id/void` | Dueño, `{reason?}` → registro anulado |
| POST | `/classes/:id/archive` | Dueño, `{confirmWithAttendance?:boolean}` |
| POST | `/courses/:id/archive` | Dueño, `{confirmWithAttendance?:boolean}` |

Listas de hasta 100 registros; búsqueda de alumnos hasta 50. Incrementar `offset` hasta recibir menos que el límite. Los endpoints de creación y mutación devuelven 201, salvo confirmación/alta manual repetida (200). Las fechas se serializan como strings ISO UTC; formatearlas al huso local al mostrar.

## Abrir asistencia

```json
{"courseId":"uuid","name":"Clase 14","durationMinutes":5}
```

Alternativamente, reemplazar `courseId` por `courseName` para crear el curso en la misma transacción. Es obligatorio exactamente uno. Duraciones permitidas 2, 5, 10; por defecto 5.

Respuesta: registro de sesión con `id`, `class_id`, `course_id`, `course_name`, `class_name`, `started_at`, `expires_at`, `status`, `server_time`. Obtener el QR mediante `/attendance-sessions/:id/qr`:

```json
{
  "qrToken":"payload.signature",
  "qrUrl":"https://frontend.example/a/payload.signature",
  "validFrom":"2026-09-18T00:00:00.000Z",
  "expiresAt":"2026-09-18T00:00:10.000Z",
  "serverTime":"2026-09-18T00:00:01.000Z",
  "rotationSeconds":10
}
```

Renderizar `qrUrl` como QR. Programar la próxima consulta usando diferencia `expiresAt - serverTime` y un margen mínimo por latencia; si ya expiró, solicitar inmediatamente uno nuevo. El backend genera el mismo QR dentro de una ventana. Deshabilitar el botón de creación durante el request: crear una sesión no es una operación idempotente y no debe reintentarse automáticamente si hubo timeout.

## Alumno: `/a/:token`

1. Inmediatamente `POST /attendance/check-in/start` con `{qrToken: token}`.
2. Conservar `{attemptId,attemptSecret,expiresAt}` en `sessionStorage` antes de OAuth. La respuesta contiene además `serverTime`. Evitar dobles inicios por React StrictMode y limpiar el intento al finalizar.
3. Si no hay sesión Supabase, mostrar Google OAuth. El callback vuelve a una ruta propia del frontend; recuperar el intento guardado sin volver a iniciar con el QR ya expirado. Si ya hay sesión, confirmar automáticamente.
4. `POST /attendance/check-in/confirm` con el JWT y `{attemptId,attemptSecret}`. No enviar nombre, email ni hora.
5. Respuesta 201 `{status:"PRESENT",attendance:{...}}` o 200 `{status:"ALREADY_PRESENT",attendance:{...}}`. El registro incluye `checked_in_at`. El nombre se obtiene de `/me` o de la identidad autenticada para presentación.

Reintentar confirmación con **el mismo** intento y secreto ante un error de red. Si el intento venció sin completarse, escanear un QR nuevo. No reintentar indefinidamente errores de validación o de autorización. Tras OAuth, el token QR inicial puede haber expirado: esto no impide confirmar un intento vivo.

## Errores para UX

| HTTP | `code` | Acción / texto |
|---|---|---|
| 404 | INVALID_QR | Código inválido |
| 410 | QR_EXPIRED | Este código expiró; escaneá el actual |
| 410 | SESSION_CLOSED | Asistencia cerrada |
| 410 | SESSION_CANCELLED | Clase o curso archivado |
| 410 | ATTEMPT_EXPIRED | Se agotó el tiempo; escaneá nuevamente |
| 404 | INVALID_ATTEMPT | Intento inválido; escaneá nuevamente |
| 409 | ATTEMPT_USED | Este intento ya fue usado por otra cuenta |
| 409 | ATTENDANCE_VOIDED | Registro anulado; consultá al profesor |
| 401 | UNAUTHENTICATED | Autenticarse o refrescar sesión |
| 403 | GOOGLE_IDENTITY_REQUIRED | Se requiere cuenta Google verificada |
| 403 | FORBIDDEN | Sin permiso de profesor |
| 409 | ARCHIVE_CONFIRMATION_REQUIRED | Pedir confirmación explícita antes de repetir con `confirmWithAttendance:true` |
| 429 | RATE_LIMITED | Esperar y reintentar |
| 500 | INTERNAL_ERROR | Error del servidor; permitir reintento seguro |

Las rutas de otro profesor responden 404. Los campos adicionales o inválidos responden 400 `REQUEST_REJECTED` con mensajes de validación. `COURSE_ARCHIVED`, `COURSE_NOT_FOUND`, `CLASS_NOT_FOUND`, `SESSION_NOT_FOUND`, `STUDENT_NOT_FOUND` y `ATTENDANCE_NOT_FOUND` indican recurso no disponible. Para el contador filtrar PRESENT; conservar VOIDED en la vista histórica.
