import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {FONT} from '../../wind64-prototype/src/font.js';
import {WIND_SCALE} from '../../wind64-prototype/src/config.js';
const glyphs=Object.entries({...FONT,'%':[5,1,2,4,5]}).map(([c,r])=>`  {${c.codePointAt(0)}, {${r.join(',')}}}`);
const palette=WIND_SCALE.map(s=>`  {${s.min},${s.rgb.join(',')}}`);
writeFileSync(fileURLToPath(new URL('../wind64/assets.h',import.meta.url)),`// Generated from the approved WIND64 v4 prototype. Run firmware/scripts/generate-assets.mjs.\n#pragma once\n#include <stdint.h>\nstruct Glyph { uint32_t code; uint8_t rows[5]; };\nstatic constexpr Glyph GLYPHS[]={\n${glyphs.join(',\n')}\n};\nstatic constexpr double PALETTE[][4]={\n${palette.join(',\n')}\n};\n`);
