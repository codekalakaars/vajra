import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const { parseJunit, parseTap, parseReport, detectFormat, parseAuto } = await import(
  pathToFileURL(join(root, 'formats/index.js')).href
)
const { classifyTest } = await import(pathToFileURL(join(root, 'classify.js')).href)
const { isSatisfied } = await import(pathToFileURL(join(root, 'verdict.js')).href)

// --- XML reader ---

const { parseXml, decodeEntities, findAll } = await import(
  pathToFileURL(join(root, 'xml.js')).href
)

test('xml reader handles elements, attributes, self-closing and nesting', () => {
  const node = parseXml('<a x="1"><b y=\'2\'/><c>text</c></a>')
  assert.equal(node.name, 'a')
  assert.equal(node.attrs.x, '1')
  assert.equal(node.children.length, 2)
  assert.equal(node.children[1].text, 'text')
})

test('xml reader handles CDATA, comments and prologues', () => {
  const node = parseXml(
    '<?xml version="1.0"?><!-- note --><a><b><![CDATA[<raw> & stuff]]></b></a>',
  )
  assert.equal(node.children[0].text, '<raw> & stuff')
})

test('xml reader decodes entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;'), 'a & b <c> A B')
})

test('xml reader returns null rather than throwing on junk', () => {
  assert.equal(parseXml('not xml at all'), null)
  assert.equal(parseXml(''), null)
})

// --- JUnit: the universal format ---

const junit = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="pytest" tests="3" failures="1" errors="1" time="0.5">
${body}
</testsuites>`

test('junit: a testcase with no result element passed', () => {
  const result = parseJunit(junit(`
  <testsuite name="tests" tests="1">
    <testcase classname="tests.test_auth" name="test_login" time="0.1"/>
  </testsuite>`))
  assert.equal(result.tests.length, 1)
  assert.equal(result.tests[0].status, 'passed')
})

test('junit: failure is distinguished from error', () => {
  // This is the reason JUnit is worth ingesting: the format already carries
  // the assertion-versus-environment distinction the verdict contract needs.
  const result = parseJunit(junit(`
  <testsuite name="tests" tests="2">
    <testcase classname="t.TestAuth" name="test_login">
      <failure message="assert 1 == 2">stack</failure>
    </testcase>
    <testcase classname="t.TestAuth" name="test_import">
      <error message="ModuleNotFoundError: no module named auth" type="ImportError"/>
    </testcase>
  </testsuite>`))
  const [failure, error] = result.tests
  assert.equal(failure.status, 'failed')
  assert.equal(failure.failureKind, 'assertion')
  assert.equal(error.status, 'errored')
  assert.equal(error.failureKind, undefined)
})

test('junit: error maps to failed_environment, failure to failed_assertion', () => {
  const result = parseJunit(junit(`
  <testsuite name="tests">
    <testcase classname="t" name="a"><failure message="boom"/></testcase>
    <testcase classname="t" name="b"><error message="kaboom"/></testcase>
  </testsuite>`))
  assert.equal(classifyTest(result.tests[0]).verdict, 'failed_assertion')
  assert.equal(classifyTest(result.tests[1]).verdict, 'failed_environment')
})

test('junit: skipped is not_collected, never a pass', () => {
  const result = parseJunit(junit(`
  <testsuite name="tests">
    <testcase classname="t" name="a"><skipped message="no marker"/></testcase>
  </testsuite>`))
  assert.equal(classifyTest(result.tests[0]).verdict, 'not_collected')
})

test('junit: a file attribute yields a file target, a classname a suite target', () => {
  const result = parseJunit(junit(`
  <testsuite name="tests">
    <testcase classname="t.TestAuth" name="a" file="src/auth.test.ts"/>
    <testcase classname="com.example.TestSession" name="b"/>
  </testsuite>`))
  assert.equal(result.tests[0].target.kind, 'file')
  assert.equal(result.tests[0].target.ref, 'src/auth.test.ts')
  // Java, Python and Go reports routinely carry no file at all.
  assert.equal(result.tests[1].target.kind, 'suite')
  assert.equal(result.tests[1].target.ref, 'com.example.TestSession')
})

test('junit: test ids are unique across suites with the same method name', () => {
  const result = parseJunit(junit(`
  <testsuite name="tests">
    <testcase classname="a.Test" name="test_login"/>
    <testcase classname="b.Test" name="test_login"/>
  </testsuite>`))
  assert.notEqual(result.tests[0].id, result.tests[1].id)
})

test('junit: nested testsuites are flattened', () => {
  const result = parseJunit(junit(`
  <testsuite name="outer">
    <testsuite name="inner">
      <testcase classname="t" name="a"/>
    </testsuite>
  </testsuite>`))
  assert.equal(result.tests.length, 1)
})

test('junit: bare testsuite root is accepted', () => {
  const result = parseJunit('<testsuite name="t"><testcase classname="t" name="a"/></testsuite>')
  assert.equal(result.tests.length, 1)
})

test('junit: durations are summed', () => {
  const result = parseJunit(junit(`
  <testsuite name="tests">
    <testcase classname="t" name="a" time="0.25"/>
    <testcase classname="t" name="b" time="0.75"/>
  </testsuite>`))
  assert.equal(result.durationMs, 1000)
})

test('junit: unparseable input returns null instead of throwing', () => {
  assert.equal(parseJunit('total garbage'), null)
  assert.equal(parseJunit('<testsuites></testsuites>'), null)
})

// --- TAP ---

test('tap: ok and not ok', () => {
  const result = parseTap('TAP version 13\n1..2\nok 1 - first\nnot ok 2 - second')
  assert.equal(result.tests.length, 2)
  assert.equal(result.tests[0].status, 'passed')
  assert.equal(result.tests[1].status, 'failed')
})

test('tap: SKIP is not_collected and TODO is not a failure', () => {
  const result = parseTap('TAP version 13\n1..2\nok 1 - a # SKIP not implemented\nok 2 - b # TODO later')
  assert.equal(result.tests[0].status, 'skipped')
  assert.equal(result.tests[1].status, 'passed')
})

test('tap: a YAML diagnostic block becomes the message', () => {
  const result = parseTap(`TAP version 13
1..1
not ok 1 - validates
  ---
  message: expected 2 but got 1
  severity: fail
  ...
`)
  assert.equal(result.tests[0].message, 'message: expected 2 but got 1; severity: fail')
})

test('tap: a bail out is an environment failure, not a pass', () => {
  const result = parseTap('TAP version 13\n1..5\nok 1 - a\nBail out! could not load fixtures')
  assert.equal(result.tests.some((t) => t.status === 'errored'), true)
})

test('tap: no version line is tolerated', () => {
  const result = parseTap('1..1\nok 1 - a')
  assert.equal(result.tests.length, 1)
})

test('tap: empty output is null', () => {
  assert.equal(parseTap(''), null)
  assert.equal(parseTap('nothing here'), null)
})

test('tap: cannot distinguish failure kinds — documented fidelity loss', () => {
  // TAP has one `not ok`. A Phase One gate therefore cannot be proven from a
  // TAP report alone, which is why JUnit is preferred where available.
  const result = parseTap('TAP version 13\n1..1\nnot ok 1 - a')
  assert.equal(result.tests[0].failureKind, 'assertion')
  assert.equal(isSatisfied('fail_on_assertion', classifyTest(result.tests[0]).verdict), true)
})

// --- dispatch ---

test('format sniffing prefers junit and defaults safely', () => {
  assert.equal(detectFormat(junit('')), 'junit')
  assert.equal(detectFormat('TAP version 13\n1..0'), 'tap')
  assert.equal(detectFormat('random'), 'junit')
})

test('parseAuto handles either format', () => {
  assert.equal(parseAuto(junit('<testsuite name="t"><testcase classname="t" name="a"/></testsuite>')).tests.length, 1)
  assert.equal(parseAuto('TAP version 13\n1..1\nok 1 - a').tests.length, 1)
})

test('parseReport dispatches on the declared format', () => {
  const xml = '<testsuite name="t"><testcase classname="t" name="a"/></testsuite>'
  assert.equal(parseReport(xml, { format: 'junit' }).tests.length, 1)
  assert.equal(parseReport('TAP version 13\n1..1\nok 1 - a', { format: 'tap' }).tests.length, 1)
})
