# Especificación: promover PokeGrid Publisher 1.3.1 a versión canónica

**Fecha:** 2026-09-28
**Estado:** aprobado para implementación
**Alcance:** repositorio `DiegoT34/PokeGrid-Script-Shop`, rama `main`

---

## 1. Contexto

El repositorio contiene tres copias del mismo producto en estados distintos:

| Ubicación | Versión | Estado |
|---|---|---|
| `dist/PokeGrid-Shop-Publisher-1.0.0/` | 1.0.0 | sin BOM, 258 líneas, obsoleta |
| raíz de `main` + `dist/PokeGrid-Shop-Publisher-1.1.0/` | 1.1 | **rota**: recursión infinita en `Git()` |
| `PokeGrid-Shop-Publisher-1.3.1/` | 1.3.1 | funcional, **sin versionar** |

`Abrir-PokeGrid-Shop-Publisher.cmd` en la raíz apunta a la 1.1 rota. El trabajo real
(3 pestañas, retirada de scripts, publicación del launcher, `git-helper.ps1`, 6 tests)
existe únicamente en una carpeta local sin trackear.

La 1.1 declara en su README haber corregido dos fallos en 1.1.1 y 1.1.2, pero esas
correcciones **solo existen dentro de la 1.3.1**. La versión distribuida nunca las
recibió.

El usuario confirma que la 1.3.1 es la versión que le funciona. Esta especificación
la convierte en el producto único del repositorio.

## 2. Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Estructura | Promover 1.3.1 a la raíz | Un solo producto, una sola versión |
| Límite de tamaño | 10 MB en publicador **y** CI | Coherencia; la 1.3.1 ya permite 10 MB |
| Git | Solo commit local, sin `push` | El workflow corre en producción |
| `catalog.schema.json` | Fuente de verdad de las reglas | Hoy nadie lo lee y ya se contradice con el CI |

## 3. Estado verificado (línea base)

Comprobado antes de diseñar. Todo lo siguiente es medición, no suposición.

- Los 6 SHA-256 de `scripts/` **coinciden** con `catalog.json`.
- `@version` y `@namespace` de cada archivo coinciden con el catálogo.
- 5 tests autocontenidos: **pasan** (`git-workflow`, `new-script-publication`,
  `script-removal`, `script-size-limit`, `launcher-publication`).
- Smoke test de la GUI: **pasa**.
- La 1.3.1 **no** tiene los fallos de recursión ni de BOM de `catalog.json` que sí
  afectan a la 1.1. Esos dos trabajos quedan fuera de alcance: ya están resueltos.
- `catalog.json` no tiene BOM actualmente.
- `Test-Json` de PowerShell usa **JsonSchema.NET desde 7.4**, que soporta draft
  2020-12. `windows-latest` ya incluye 7.4+.
- `core.autocrlf = true` en esta máquina.

## 4. Estructura final

```
PokeGrid-Script-Shop/
├── catalog.json                      sin cambios
├── catalog.schema.json               reescrito (§7)
├── scripts/                          sin cambios
├── tools/
│   ├── git-helper.ps1                nuevo
│   ├── publish-script.ps1            ← 1.3.1
│   ├── remove-script.ps1             nuevo
│   ├── publish-launcher.ps1          nuevo
│   ├── test-git-workflow.ps1         nuevo
│   ├── test-launcher-publication.ps1 nuevo
│   ├── test-new-script-publication.ps1 nuevo
│   ├── test-publication-pipeline.ps1 nuevo
│   ├── test-script-removal.ps1       nuevo
│   └── test-script-size-limit.ps1    nuevo
├── PokeGrid-Shop-Publisher.ps1       ← 1.3.1
├── Abrir-PokeGrid-Shop-Publisher.cmd ← 1.3.1
├── PUBLISHER-README.md               ← 1.3.1
├── README.md                         sin cambios
├── .github/workflows/validate-catalog.yml  reescrito (§8)
├── .gitattributes                    ampliado (§9)
└── docs/superpowers/specs/           nuevo
```

La carpeta `PokeGrid-Shop-Publisher-1.3.1/` se elimina tras la copia.

**Regla de copia:** preservar bytes exactos, incluyendo BOM y finales de línea.
Se usa copia a nivel de byte, no reescritura de contenido.

## 5. Correcciones de código

### 5.1 `minLauncherVersion` unificado a `0.22.1`

Hoy hay tres valores distintos: la GUI propone `0.22.3`, el CLI usa `0.22.1`, y los
6 scripts publicados declaran `0.22.1`. Publicar desde la GUI sube el requisito
mínimo del launcher sin avisar.

Se cambia a `0.22.1` en las 3 ocurrencias de `PokeGrid-Shop-Publisher.ps1`
(líneas 237, 255 y 492). `tools/publish-script.ps1` ya usa `0.22.1`: no se toca.

`0.22.1` es el valor que ya tienen las publicaciones reales, así que no cambia
nada para el usuario.

### 5.2 Rollback de escrituras parciales en `tools/publish-script.ps1`

**Problema concreto:** el publicador escribe `scripts/<id>.user.js` (línea 103) y
después `catalog.json` (línea 131). Si la segunda escritura falla —disco lleno,
archivo bloqueado por el antivirus, falta de permisos— queda el archivo nuevo
publicado junto a un catálogo viejo. Estado incoherente: el `.user.js` en disco no
coincide con ningún SHA-256 del catálogo.

**Alcance deliberadamente limitado a la ventana previa al commit.** El flujo de la
GUI es `pull → publicar → add → commit → push`. Si falla el **push**, el commit ya
existe y es correcto: revertirlo destruiría trabajo recuperable con un simple
`git push`. Por eso el rollback va dentro de `publish-script.ps1` (que no toca
Git), no en el manejador de la GUI.

Implementación: antes de escribir, guardar en memoria los bytes actuales de
`catalog.json` y del `scripts/<id>.user.js` objetivo, más un indicador de si ese
último existía. Envolver las escrituras en `try/catch`; ante cualquier excepción,
restaurar el estado previo y volver a lanzar el error original.

### 5.3 Mensaje explícito cuando el commit existe pero el push falla

En el manejador de publicación de `PokeGrid-Shop-Publisher.ps1`, envolver el
`git push` para que, si falla, el mensaje indique que el commit **ya se creó
localmente** y que el catálogo online no cambió, con el comando a ejecutar. Hoy el
mensaje genérico deja al usuario sin saber si perdió trabajo.

### 5.4 Límite de 10 MB visible antes de publicar

El texto inicial del campo de ayuda pasa a incluir el límite:
`Arrastra un archivo aquí o utiliza Examinar. Tamaño máximo: 10 MB.`

Cuando el script cargado supera el 50 % del límite, el texto de estado cambia a
ámbar e incluye el porcentaje: `X MB · 62 % del límite de 10 MB`.

## 6. BOM en archivos con acentos

**Bug confirmado.** Tres archivos `.ps1` contienen caracteres no ASCII pero se
guardaron **sin BOM**. `Abrir-PokeGrid-Shop-Publisher.cmd` invoca `powershell.exe`
—Windows PowerShell 5.1—, que sin BOM interpreta el archivo como ANSI y muestra los
acentos como caracteres rotos.

| Archivo | BOM | No-ASCII | Impacto |
|---|---|---|---|
| `remove-script.ps1` | no | 2 | **Producción**: "No se encontró catalog.json" |
| `test-script-removal.ps1` | no | 5 | Salida de test |
| `test-script-size-limit.ps1` | no | 9 | Salida de test |

Los otros 8 `.ps1` ya tienen BOM, que es lo correcto para 5.1.

Se añade BOM a los tres. `Abrir-PokeGrid-Shop-Publisher.cmd` se queda sin BOM: es
ASCII puro y un `.cmd` con BOM se ejecuta mal en Windows.

## 7. `catalog.schema.json` como fuente de verdad

Se amplía el schema existente para documentar todos los campos que el publicador
escribe, sin cambiar los required actuales (evitar romper el catálogo publicado).

Cambios:
- Declarar `games` como `array` de `string` con `maxLength: 80`. La 1.3.1 lo
  escribe y `additionalProperties: true` ya lo permitía, pero era invisible.
- Declarar `author`, `summary`, `description`, `category`, `tags`, `permissions`,
  `changelog`, `icon`, `featured`, `publishedAt` y `homepage` como propiedades
  opcionales documentadas.
- Mantener `required` con los 10 campos actuales.
- Mantener `maxItems: 200` en `scripts`, que el CI nunca aplicó.

**Límite conocido:** `format` (`date-time`, `uri`) es una anotación en JSON Schema;
los validadores lo ignoran por defecto. Por eso el workflow añade una comprobación
explícita de `updatedAt` (§8). El `format: uri` de `downloadUrl` no necesita check
propio: la igualdad exacta contra la URL derivada ya lo garantiza.

## 8. Workflow de validación

`.github/workflows/validate-catalog.yml` se reescribe en tres capas, cada una
haciendo lo que mejor sabe:

**Job `validate`**

1. *Schema* — `Get-Content catalog.json -Raw | Test-Json -SchemaFile catalog.schema.json`
   Se usa la tubería, no `Test-Json -Path`, porque `-Path`/`-LiteralPath` para el
   JSON solo existen desde 7.4; la forma con tubería funciona en cualquier 7.x.
2. *Formato y unicidad* (PowerShell):
   - `updatedAt` contra `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`
   - `schemaVersion` debe ser `1`
   - IDs únicos y con el patrón `^[a-z0-9][a-z0-9._-]{1,79}$`
   - `version` con `^\d+\.\d+\.\d+(?:[-+].*)?$`
   - `sha256` con `^[a-f0-9]{64}$`
   - `downloadUrl` igual a la URL derivada del `id`
3. *Archivo en disco*:
   - existe `scripts/<id>.user.js`
   - **tamaño ≤ 10 MB** (antes 1 MB) — corregido contra la 1.3.1
   - SHA-256 real coincide con el del catálogo
   - `@version` y `@namespace` del archivo coinciden con la entrada

El límite de tamaño vive en PowerShell, no en el schema: un schema no puede
conocer el tamaño de un archivo en disco.

**Job `test`**

Ejecuta los 5 tests autocontenidos, en este orden, abortando al primer fallo:

```
test-git-workflow
test-new-script-publication
test-script-removal
test-script-size-limit
test-launcher-publication
```

Ambos jobs corren en `push` a `main` y en `pull_request`, igual que hoy.

**`test-publication-pipeline.ps1` queda fuera del CI, deliberadamente.** Su
`RepositoryRoot` por defecto apunta a `%LOCALAPPDATA%\PokeGrid-Shop-Publisher\repository`,
que no existe en un runner limpio: fallaría siempre y entrenaría a ignorar el job
en rojo. Se le añade un mensaje de error explícito que indique qué falta, y queda
como herramienta local.

## 9. `.gitattributes`

El archivo actual solo fija `scripts/*.user.js text eol=lf`. Con
`core.autocrlf=true` en esta máquina, el comportamiento del resto depende de la
configuración de cada máquina.

Se añade `* text=auto eol=lf` al principio. Efectos:

- Los finales de línea pasan a ser LF de forma determinista en cualquier equipo.
- La regla explícita de `scripts/*.user.js` se conserva: es la que protege los
  archivos cuyo SHA-256 es el contrato con el launcher.
- El BOM **no** se ve afectado: Git normaliza solo finales de línea.

`dist/` está en `.gitignore`, así que los `.zip` y el `.png` quedan fuera.

## 10. Fuera de alcance

**El `@name` de `exact-iv-scanner` dice "56.0" y su versión es `56.5.0`.** Parece un
detalle de una línea, pero cambiarlo rompe la publicación. `Find-CatalogEntry`
identifica una actualización por la combinación exacta `@name` + `@namespace`. Al
cambiar el `@name`, la entrada existente deja de coincidir, el script se clasifica
como nuevo, `Get-UniqueScriptId` le asigna un ID libre distinto y **el script
aparece duplicado en la Shop**. Corregirlo exige una migración explícita, no una
edición. Se documenta, no se ejecuta.

Otros elementos fuera de alcance, con motivo:

- **Los 6 userscripts de `scripts/`.** Funcionan, con sus hashes correctos.
- **El orden de entradas del catálogo.** `publish-script.ps1:128` coloca lo publicado
  al principio. Con 6 scripts es irrelevante; con 80 el launcher lo ordenaría igual.
- **`scripts/.gitkeep`.** Resto de cuando la carpeta estaba vacía. Se elimina.
- **`catalog.json` con CRLF mientras todo lo demás usa LF.** Cosmético. Tras
  promoting, `.gitattributes` normalizará a LF en el próximo commit que lo toque.
- **`dist/`.** Ya ignorado por Git. Se regenera cuando el usuario quiera, no en este
  trabajo.
- **`dist/PokeGrid-Shop-Publisher-1.0.0/`.** Se queda como está hasta que el
  usuario decida qué hacer con artefactos antiguos.

## 11. Verificación

Antes de entregar el commit, en este orden:

1. `catalog.json` actual valida contra el schema nuevo **sin modificarlo**.
2. Smoke test de la GUI: `powershell.exe -NoProfile -ExecutionPolicy Bypass -STA
   -File PokeGrid-Shop-Publisher.ps1 -SmokeTest` → exit 0.
3. Los 5 tests autocontenidos → los 5 en verde.
4. **Prueba de la corrección de 10 MB:** publicar un userscript de 6 MB en un
   repositorio temporal y confirmar que la lógica del workflow lo aceptaría.
   Es el gap exacto que `test-script-size-limit.ps1` no cubría.
5. Verificar que los 3 archivos de §6 tienen BOM y que ningún otro cambió de
   codificación.
6. `git status` confirma que `catalog.json` no cambió.
7. `git diff --stat` confirma que ninguno de los 6 `.user.js` cambió. La única
   modificación esperada bajo `scripts/` es la eliminación de `.gitkeep` (§10).

**No se hace `push`.** El trabajo queda en un commit local para revisión.

## 12. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| El workflow falla en GitHub por algo no verificable en local (`pwsh` no está instalado aquí) | Push bloqueado | Job `validate` y job `test` independientes: un fallo en tests no oculta la validación del catálogo |
| Reordenar la raíz rompe una referencia externa | Alguien usa `dist/1.1.0.zip` | `dist/` no se toca; los ZIP antiguos siguen ahí |
| `Test-Json` se comporta distinto en 7.4+ que en 7.3 | Validación fallida en CI | El schema solo usa palabras clave compatibles con draft-07 en adelante, que ambos validadores soportan |
| Un `.ps1` con BOM no se lee bien en un editor sin soporte | Fricción menor | Es el tradeoff correcto: la app corre en PowerShell 5.1, y 5.1 necesita el BOM |

## 13. Commit

Un solo commit, mensaje en español, sin `push`:

```
Promover PokeGrid Publisher 1.3.1 a la versión canónica

Sustituye la 1.1 de la raíz, que no puede publicar por una recursión
infinita en su función Git(), por la 1.3.1 que sí funciona. La 1.1 nunca
recibió las correcciones que su propio README atribuye a 1.1.1 y 1.1.2;
esas correcciones vivían solo en la carpeta 1.3.1, sin versionar.

- Adopta el límite de 10 MB del publicador en el workflow, que seguía en 1 MB
- Convierte catalog.schema.json en la fuente de verdad de las reglas del catálogo
- Añade un job que ejecuta las cinco pruebas del publicador
- Unifica minLauncherVersion en 0.22.1 entre GUI, CLI y catálogo
- Restaura catalog.json y el userscript si la publicación falla a medias
- Añade el BOM que PowerShell 5.1 necesita a tres archivos con acentos
- Fija finales de línea LF en .gitattributes

El catálogo y los seis userscripts no se modifican.
```
