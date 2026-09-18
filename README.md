# Backend de asistencia universitaria v1

API NestJS para React/Vercel, Supabase Auth (Google) y PostgreSQL de Supabase. No incluye el frontend.

## Desarrollo

Requiere Node 22 o posterior y PostgreSQL. Desde esta carpeta:

```powershell
npm ci
Copy-Item .env.example .env
# Completar las variables de .env y generar un secreto QR aleatorio.
npm run migrate
npm run build
npm start
```

`npm run dev` ofrece recarga durante desarrollo. `npm run check` compila y ejecuta las pruebas. Las pruebas usan PostgreSQL embebido (PGlite) y no necesitan credenciales ni modifican Supabase.

## Supabase y primer administrador

1. Habilitar Google en Authentication / Providers. Configurar las credenciales OAuth y las URLs de retorno del frontend en Supabase y Google.
2. Configurar `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` (publishable o anon). La clave privada de Google y la service role no se usan en React ni son necesarias para validar usuarios en Nest.
3. Configurar `DATABASE_URL` con acceso PostgreSQL al proyecto (conexión directa o pooler de sesión). En producción usar TLS verificado: `DATABASE_SSL=true`; si hace falta, suministrar el certificado CA en `DATABASE_CA`.
4. Ejecutar migraciones con un rol propietario de las tablas. El backend debe conectarse con ese mismo rol, o uno de backend específicamente autorizado con acceso y políticas adecuadas. El esquema privado tiene RLS sin políticas de acceso para clientes.
5. Iniciar sesión con Google desde el frontend y llamar `GET /me` con el access token para crear el perfil local.
6. En el SQL Editor de Supabase, promover explícitamente el UUID autenticado del profesor:

```sql
UPDATE attendance_app.profiles
SET role = 'ADMIN'
WHERE id = 'UUID-DEL-USUARIO-SUPABASE';
```

No hay registro público de administradores ni roles derivados del email o de user_metadata. Cada profesor administra sus propios cursos. Los administradores pueden buscar los perfiles existentes para alta manual; un alumno debe haber iniciado sesión al menos una vez para aparecer en esa búsqueda.

## Integración

Consultar [API.md](API.md). Todos los IDs son UUID. Las fechas están en ISO 8601 UTC. Los registros de base se devuelven en snake_case; los DTO de entrada, QR e intentos usan camelCase según ejemplos. Los errores son `{ "code": "..." }`, con `message` adicional para validación.

Se usa polling: resumen/listado cada 3–5 segundos y QR según `expiresAt` y `serverTime`. No está habilitado Supabase Realtime ni acceso directo a tablas desde React.

## Seguridad y decisiones

- El backend valida el JWT contra Supabase con `auth.getUser(jwt)` y exige identidad Google y email confirmado. [Referencia oficial](https://supabase.com/docs/reference/javascript/auth-getuser).
- QR HMAC-SHA256 con propósito y versión, rotación de 10 segundos configurable. El secreto solamente vive en backend. Tokens antiguos no tienen tolerancia adicional.
- Hora PostgreSQL (`clock_timestamp`) después de adquirir los bloqueos. Los timestamps del cliente nunca deciden validez.
- Intentos de 60 segundos con ID y secreto aleatorio; solamente se almacena el hash del secreto. Guardar ambos temporalmente en `sessionStorage` para sobrevivir al OAuth en la misma pestaña. No publicar ni registrar esos valores en logs.
- Cerrar/expirar impide nuevos intentos, pero permite finalizar los ya emitidos y vigentes. Archivar cancela también los pendientes.
- Transacción, consumo del intento y `UNIQUE(session_id,user_id)` previenen duplicados. Los reintentos completados del mismo usuario devuelven `ALREADY_PRESENT`; otro usuario recibe `ATTEMPT_USED`.
- Las anulaciones conservan autor, fecha y razón. No se pueden reactivar mediante escaneo o alta manual. El MVP no incluye restauración.
- Se bloquea primero el curso, luego la sesión y el intento para coordinar altas, cierres y archivados. Esto serializa escrituras de un mismo curso y es una elección simple para el MVP.
- [Rate limiting de Nest](https://docs.nestjs.com/security/rate-limiting): 300 inicios/minuto/IP y 1200 solicitudes/minuto/IP globalmente, contemplando Wi-Fi compartido. Contadores en memoria, adecuados para una instancia; múltiples réplicas requieren almacenamiento compartido. Ajustar `TRUST_PROXY_HOPS` a la topología real, no confiar indiscriminadamente en headers de IP.
- Respuestas sin caché, Helmet, CORS explícito, cuerpos limitados, validación estricta y consultas parametrizadas. Logs de error sin credenciales ni datos del alumno.
- Un QR compartido mientras sigue vigente todavía puede usarse: no constituye prueba absoluta de presencia física. No se agrega geolocalización ni fingerprinting.

## Render

Usar `render.yaml` como Blueprint (está dentro de esta carpeta; seleccionar esa ruta al crear el Blueprint). `rootDir` supone que esta carpeta está dentro de la raíz del repositorio. Si se convierte en repositorio separado, quitar `rootDir`.

Build: `npm ci && npm run build`. Migración: `npm run migrate`. Inicio: `npm start`. Health: `/health/ready`. Si el plan no admite pre-deploy, ejecutar la migración manualmente antes de arrancar. Completar variables y configurar en Vercel la URL pública del backend. No hay despliegue ni credenciales reales incluidos.

Los cold starts pueden hacer expirar un QR antes de que el servidor lo procese: el frontend debe informar el error y pedir escanear el actual. Para uso en clases, mantener disponible la instancia durante la asistencia. La limpieza periódica de intentos antiguos queda como operación de mantenimiento; nunca eliminar asistencias como parte de ella.

Las pruebas embebidas verifican lógica y restricciones PostgreSQL. La validación final con Google real, red, proxy y Supabase/Render requiere configurar esos servicios; PGlite no sustituye una prueba de concurrencia con varias conexiones PostgreSQL reales.
