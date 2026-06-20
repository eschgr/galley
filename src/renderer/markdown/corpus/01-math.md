# Math fidelity

Claude emits math with **several delimiter styles**, often mixed in one reply.
All of the following must render — and a malformed formula must degrade to its
raw source, not break the page.

## Inline, dollar style

The time complexity is $O(n \log n)$, and the probability is $p = \frac{1}{2}$.
Euler's identity, $e^{i\pi} + 1 = 0$, is often called the most beautiful
equation. The vector $\mathbf{v} = (v_1, v_2, \dots, v_n)$ has norm
$\lVert \mathbf{v} \rVert = \sqrt{\sum_{i=1}^{n} v_i^2}$.

## Inline, backslash-paren style

The derivative \(f'(x) = \lim_{h \to 0} \frac{f(x+h) - f(x)}{h}\) defines the
slope, and the identity \(\sin^2\theta + \cos^2\theta = 1\) holds for all
\(\theta\).

## Block, dollar style

The Gaussian integral:

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

A matrix and an aligned derivation:

$$
A = \begin{pmatrix} a & b \\ c & d \end{pmatrix},
\qquad
\det(A) = ad - bc
$$

$$
\begin{aligned}
(x + y)^2 &= x^2 + 2xy + y^2 \\
          &= x^2 + y^2 + 2xy
\end{aligned}
$$

## Block, backslash-bracket style

The quadratic formula:

\[
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
\]

## Literal dollar signs in prose (must NOT become math)

The widget costs $5 and the deluxe model costs $12, so two of each is $34 total.
A 20% discount on a $50 item saves you $10.

## Malformed formula (R6 floor — should show raw source, not crash)

This is broken on purpose: $\frac{1}{0 \notACommand{x}$ — the rest of the
document must still render fine below.

Inline after the break works: $a^2 + b^2 = c^2$.
