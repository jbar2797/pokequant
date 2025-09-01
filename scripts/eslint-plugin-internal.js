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
};
