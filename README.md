# Sistema de Desvíos STM — UPTU

Herramienta interna de la Unidad de Programación del Transporte Urbano
(División Transporte, Intendencia de Montevideo) para publicar y consultar
los desvíos operativos de las líneas de ómnibus.

- **Uso:** ver `LEEME.txt`
- **Base de datos:** `sql/desvios-supabase-completo.sql`
- **Envío de correo:** `envio-correo-apps-script.gs`

El acceso requiere cuenta: sin sesión iniciada no se muestra ningún desvío.

## Publicación

El sitio se sirve con GitHub Pages desde la rama `main`, carpeta raíz.
Para actualizarlo, subir los archivos modificados y esperar un minuto.

> Este repositorio es público, por lo que **no debe contener contraseñas ni
> claves reutilizadas en otros servicios**. La clave del script de envío
> (`ENVIO_CLAVE` en `app.js`) es visible por diseño: lo que protege el envío
> es la lista fija de casillas dentro del Apps Script.
