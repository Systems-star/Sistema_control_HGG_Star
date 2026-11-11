# Golden Gate · Recepción

En VS Code abre D:\horarioweb y ejecuta en la terminal PowerShell (Python 3):

```powershell
python servidor.py --usuario recepcion
python servidor.py
```

La primera orden solicita una contraseña de al menos diez caracteres. Repite con otro nombre para crear otra cuenta. Abre http://127.0.0.1:8080. La base recepcion.sqlite3 contiene las cuentas y las estancias. Detén el servidor antes de copiarla como respaldo.

## Uso desde varios equipos

En una red privada de confianza, inicia una sola instancia con `python servidor.py --host 0.0.0.0`. Desde el teléfono en la misma Wi-Fi abre http://IP-DEL-PC:8080. Usa la IPv4 del adaptador Wi-Fi que muestra ipconfig y permite el puerto solo en la red privada. Mantén encendido el equipo. Para uso desde otras redes configura un servidor permanente con almacenamiento persistente y un proxy HTTPS, activa COOKIE_SECURE=1 en el entorno del servidor y comparte el mismo dominio con todos los equipos. El servidor incluido es para pruebas locales.

Selecciona una habitación, introduce la fecha y hora de entrada en horario de Huancayo-Chupaca y elige la modalidad. La salida se calcula automáticamente. El panel consulta los cambios cada tres segundos mientras está visible. El historial incluye estancias pasadas, actuales y programadas.

## Móvil

Desde el sitio HTTPS puedes instalar la web en Android mediante el menú del navegador. En iPhone usa Safari → Compartir → Agregar a inicio. Se requiere conexión al servidor.

Para generar paquetes nativos usa la configuración Capacitor incluida, Node 22 o superior y un dominio HTTPS que sirva esta aplicación. En PowerShell:

```powershell
$env:RECEPCION_URL = 'https://tu-dominio-real'
npm.cmd install
npx.cmd cap add android
npx.cmd cap sync android
npm.cmd run android
```

En Android Studio instala el SDK requerido por el proyecto y usa Build → Generate Signed App Bundle or APK → APK para distribución. Guarda la clave de firma.

Para iOS, en un Mac con Xcode y CocoaPods, configura la misma dirección con `export RECEPCION_URL='https://tu-dominio-real'`, ejecuta `npm install`, `npx cap add ios`, `npx cap sync ios` y `npm run ios`. Selecciona el equipo de firma en Xcode y usa Product → Archive para distribuir el paquete por el canal autorizado de Apple.

