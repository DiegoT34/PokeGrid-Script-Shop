# PokeGrid Publisher 1.3.1 para Windows

La herramienta permite administrar desde una sola interfaz tanto la **Shop de scripts** como las **versiones del launcher PokeGrid**. Su diseño es adaptable, muestra el estado del repositorio y pide confirmación antes de publicar cambios en GitHub.

## Abrir

Haz doble clic en `Abrir-PokeGrid-Shop-Publisher.cmd`.

## Requisitos

- Windows 10 u 11.
- Git instalado.
- GitHub CLI instalado y autorizado como `DiegoT34` para preparar automáticamente el repositorio de la Shop.
- Una copia local del repositorio `DiegoT34/PokeGrid-Launcher` para publicar el launcher.
- Node.js y pnpm solamente si activas las pruebas o la compilación local del launcher.

Para autorizar GitHub CLI por primera vez:

```powershell
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
```

## Publicar o actualizar un script

1. Arrastra el userscript sobre la ventana o pulsa **Examinar**.
2. La aplicación leerá los metadatos automáticamente.
3. Conserva el mismo **ID estable** cuando sea una actualización.
4. Completa categoría, etiquetas, resumen, descripción, permisos y changelog.
5. Revisa la vista previa y pulsa **Validar**.
6. Comprueba el indicador **SCRIPT NUEVO** o **ACTUALIZACIÓN EXISTENTE**.
7. Pulsa **Agregar nuevo script** o **Publicar actualización**.

El Publisher acepta userscripts de hasta **10 MB**, tanto desde la interfaz como mediante `tools\publish-script.ps1`.

La aplicación sincronizará el repositorio, copiará el script, normalizará la versión si es necesario, calculará SHA-256, actualizará el catálogo, creará el commit, hará `git push` y comprobará que la versión ya sea visible online.

GitHub Actions validará nuevamente el catálogo. Si el proceso termina correctamente, los usuarios podrán verlo con **Scripts → Shop online → Verificar**.

### Agregar un script completamente nuevo

1. Asegúrate de que el archivo declare `@name`, `@namespace` y una `@version` con formato `X.Y.Z`.
2. Arrástralo a la herramienta o selecciónalo con **Examinar**.
3. Verifica que la tarjeta lateral indique **SCRIPT NUEVO**.
4. La herramienta propondrá un ID libre. Puedes cambiarlo antes de publicar, siempre que no exista en el catálogo.
5. Completa la categoría, resumen, descripción, permisos y cambios de la primera versión.
6. Pulsa **Agregar nuevo script** y confirma el modo **NUEVO SCRIPT**.

Si la combinación exacta de `@name` y `@namespace` ya existe, la herramienta la identificará como actualización, bloqueará su ID estable y conservará su ficha. Un namespace genérico compartido por varios userscripts no basta para confundirlos.

La etiqueta del juego se obtiene automáticamente de `@match`/`@include`. Si deseas un nombre más amigable que el dominio, añade una o varias líneas como `// @game Nombre del juego`; el Publisher guardará esas etiquetas en el catálogo para que el launcher las muestre antes de instalar.

## Consultar y retirar scripts publicados

1. Abre la pestaña **Catálogo publicado**.
2. Pulsa **Sincronizar** para traer desde GitHub la versión más reciente de la Shop.
3. Busca por nombre, ID, juego, autor, categoría o etiqueta.
4. Selecciona una publicación para revisar su versión, juego, descripción, fecha y SHA-256.
5. Pulsa **Ver archivo** si quieres inspeccionar el userscript publicado en GitHub.
6. Para retirarlo, pulsa **Retirar de la Shop** y confirma el nombre mostrado.

La retirada elimina únicamente la entrada seleccionada de `catalog.json` y su archivo `scripts/<id>.user.js`. Después crea un commit y lo sube a GitHub. Los usuarios que ya lo instalaron conservan su copia local, pero el script deja de aparecer para nuevas instalaciones o actualizaciones desde la Shop.

## Publicar una versión del launcher

1. Abre la pestaña **Versiones del launcher**.
2. Selecciona la carpeta local de `PokeGrid-Launcher` o pulsa **Detectar**.
3. Revisa la versión local, la última versión publicada y los archivos pendientes.
4. Confirma la versión propuesta o escribe una versión `X.Y.Z` superior.
5. Describe los cambios de la versión.
6. Si lo deseas, activa **Ejecutar pruebas locales** y **Compilar antes de publicar**.
7. Pulsa **Validar versión** y después **Publicar nueva versión**.

La herramienta comprueba el remoto oficial y la rama `main`, sincroniza las etiquetas, actualiza `package.json`, crea el commit, sube `main` y publica la etiqueta `vX.Y.Z`. El workflow oficial de GitHub Actions compila el launcher, crea el ZIP y su archivo SHA-256, y los adjunta al Release. Al finalizar, la herramienta verifica ambos archivos y abre la página de la nueva versión.

Los userscripts `.user.js` o `.js` y los archivos comprimidos `.zip`, `.rar` o `.7z` ubicados en la raíz del proyecto quedan excluidos de la publicación del launcher. Antes de confirmar se muestra la lista exacta de archivos que sí serán incluidos.

## Seguridad de la publicación

- No se publica nada al abrir la herramienta ni al pulsar **Validar**.
- La subida requiere una confirmación final con repositorio, versión y archivos incluidos.
- No se permite reemplazar una etiqueta ya publicada.
- Si el repositorio remoto contiene cambios nuevos, la herramienta intenta sincronizarlo de forma segura y detiene la publicación si existe un conflicto.
- La compilación local es opcional; la creación oficial del Release siempre queda a cargo de GitHub Actions.

## Corrección 1.1.1

- Corrige el desbordamiento de profundidad causado por la función interna que ocultaba a `git.exe`.
- Ejecuta siempre la ruta real de Git y evita solicitudes de credenciales ocultas detrás de la interfaz.
- Incluye `tools\test-git-workflow.ps1`, que valida pull, add, commit y push contra un remoto temporal.
- Incluye `tools\test-publication-pipeline.ps1`, que valida catálogo, versión y SHA-256 sin publicar nada.

## Corrección 1.1.2

- Guarda `catalog.json` en UTF-8 sin BOM para que el launcher pueda leerlo con `JSON.parse()`.

## Novedades 1.2.0

- Nueva pestaña **Versiones del launcher** conectada con `DiegoT34/PokeGrid-Launcher`.
- Detección automática del repositorio, versión local, último Release y cambios pendientes.
- Propuesta automática de la siguiente versión de parche.
- Publicación guiada mediante commit, push y etiqueta de Release.
- Pruebas y compilación local opcionales antes de publicar.
- Seguimiento de GitHub Actions y comprobación del ZIP y SHA-256 del Release.
- Prueba automatizada del flujo completo contra un repositorio Git temporal.

## Corrección 1.2.1

- Distingue los scripts nuevos exclusivamente por la combinación exacta de `@name` y `@namespace` del catálogo.
- Limpia el ID y los metadatos de la selección anterior antes de analizar otro archivo.
- Genera automáticamente un ID libre para cada publicación nueva.
- Separa los modos internos `New` y `Update` para impedir que un script nuevo reemplace accidentalmente otro existente.
- Bloquea el ID estable al cargar una actualización y conserva el `publishedAt` original.
- Incluye una prueba automatizada para alta nueva, colisión de ID y actualización posterior.

## Novedades 1.3.0

- Nueva pestaña **Catálogo publicado** con buscador, estadísticas y listado visual de todas las publicaciones.
- Panel de detalle con juego, categoría, autor, versión, descripción, fecha y SHA-256.
- Acceso directo al archivo publicado en GitHub.
- Retirada guiada y confirmada de scripts de la Shop.
- Eliminación exacta y segura de la entrada del catálogo y de su `.user.js`, sin afectar otras publicaciones.
- Sincronización previa, commit, push y verificación online automáticos.
- Nueva prueba aislada del flujo de retirada.

## Corrección 1.3.1

- Amplía de 1 MB a 10 MB el tamaño máximo de los userscripts.
- Unifica el límite de la interfaz gráfica y del publicador de línea de comandos.
