export const rules = {
  'no-raw-error-literal': {
    meta: { type: 'problem', docs: { description: 'Disallow raw json({ ok:false, error:\'...\' }) patterns; use err(ErrorCodes.*)' }, schema: [] },
    create(context) {
      return {
        CallExpression(node) {
          try {
            // Match json({ ok:false, error:'something' } , ...)
            if (node.callee.type === 'Identifier' && node.callee.name === 'json' && node.arguments.length) {
              const first = node.arguments[0];
              if (first && first.type === 'ObjectExpression') {
                const okProp = first.properties.find(p=> p.type==='Property' && p.key.type==='Identifier' && p.key.name==='ok');
                const errProp = first.properties.find(p=> p.type==='Property' && p.key.type==='Identifier' && p.key.name==='error');
                if (okProp && errProp && okProp.value.type === 'Literal' && okProp.value.raw === 'false') {
                  if (errProp.value.type === 'Literal' && typeof errProp.value.value === 'string') {
                    const val = errProp.value.value;
                    // Allow if obviously using ErrorCodes constant substitution is absent
                    context.report({ node, message: `Raw error literal '${val}' – use err(ErrorCodes.*) helper instead.` });
                  }
                }
              }
            }
          } catch {/* ignore */}
        }
      };
    }
  }
  , 'no-ad-hoc-network-retry': {
    meta: { type: 'suggestion', docs: { description: 'Discourage custom inline retry loops for Network connection lost; rely on global patched fetch or fetchRetry helper' }, schema: [] },
    create(context) {
      return {
        Literal(node) {
          try {
            if (typeof node.value === 'string' && /Network connection lost/.test(node.value)) {
              // Look upward for a while to detect while/for loop presence in same function.
              let p = node.parent;
              let loopFound = false;
              let depth = 0;
              while (p && depth < 6) {
                if (p.type === 'WhileStatement' || p.type === 'ForStatement') { loopFound = true; break; }
                p = p.parent; depth++;
              }
              if (loopFound) {
                context.report({ node, message: 'Inline retry loop on "Network connection lost" detected. Remove loop; global fetch retry is applied or use fetchRetry helper.' });
              }
            }
          } catch {/* ignore */}
        }
      };
    }
  }
};
