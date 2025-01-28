import { sleep, NetworkProvider, UIProvider } from '@ton/blueprint';
import { Address, Cell, toNano } from '@ton/core';
import { TonClient, TonClient4 } from '@ton/ton';

export const stringAmountToNumber = (amount: string) => {
    return parseInt(toNano(parseFloat(amount)).toString());
};

export const promptBool = async (prompt: string, options: [string, string], ui: UIProvider, choice: boolean = true) => {
    let yes = false;
    let no = false;
    let opts = options.map((o) => o.toLowerCase());

    do {
        let res = (
            choice
                ? await ui.choose(prompt, options, (c: string) => c)
                : await ui.input(`${prompt}(${options[0]}/${options[1]})`)
        ).toLowerCase();
        yes = res == opts[0];
        if (!yes) no = res == opts[1];
    } while (!(yes || no));

    return yes;
};

export const promptCell = async (prompt: string, ui: UIProvider) => {
    let retry = false;
    let input = '';
    let res: Cell | null = null;

    do {
        input = await ui.input(prompt);
        try {
            res = Cell.fromBase64(input);

            retry = false;
        } catch (e) {
            ui.write(input + " doesn't look like a valid cell base64:\n" + e);
            retry = !(await promptBool('Use anyway?(y/n)', ['y', 'n'], ui));
        }
    } while (retry);

    return res;
};

export const promptUrl = async (prompt: string, ui: UIProvider) => {
    let retry = false;
    let input = '';
    let res = '';

    do {
        input = await ui.input(prompt);
        try {
            let testUrl = new URL(input);
            res = testUrl.toString();
            retry = false;
        } catch (e) {
            ui.write(input + " doesn't look like a valid url:\n" + e);
            retry = !(await promptBool('Use anyway?(y/n)', ['y', 'n'], ui));
        }
    } while (retry);
    return input;
};

export const promptAddress = async (prompt: string, provider: UIProvider, fallback?: Address) => {
    let promptFinal = fallback ? prompt.replace(/:$/, '') + `(default:${fallback}):` : prompt;
    do {
        let testAddr = (await provider.input(promptFinal)).replace(/^\s+|\s+$/g, '');
        try {
            return testAddr == '' && fallback ? fallback : Address.parse(testAddr);
        } catch (e) {
            provider.write(testAddr + ' is not valid!\n');
            prompt = 'Please try again:';
        }
    } while (true);
};

export const promptAmount = async (prompt: string, provider: UIProvider) => {
    let resAmount: number;
    do {
        let inputAmount = await provider.input(prompt);
        resAmount = Number(inputAmount);
        if (isNaN(resAmount)) {
            provider.write('Failed to convert ' + inputAmount + ' to float number');
        } else {
            return resAmount.toFixed(9);
        }
    } while (true);
};

export const promptNumber = async (prompt: string, provider: UIProvider) => {
    let resAmount: number;
    do {
        let inputAmount = await provider.input(prompt);
        resAmount = Number(inputAmount);
        if (isNaN(resAmount)) {
            provider.write('Failed to convert ' + inputAmount + ' to float number');
        } else {
            return resAmount;
        }
    } while (true);
};

export const getLastBlock = async (provider: NetworkProvider) => {
    const api = provider.api() as TonClient4;

    return (await api.getLastBlock()).last.seqno;
};
export const getAccountLastTx = async (provider: NetworkProvider, address: Address) => {
    const api = provider.api() as TonClient4;

    const res = await api.getAccountLite(await getLastBlock(provider), address);
    if (res.account.last == null) throw Error('Contract is not active');
    return res.account.last.lt;
};
export const waitForTransaction = async (
    provider: NetworkProvider,
    address: Address,
    curTxLt: bigint | null,
    maxRetry: number,
    interval: number = 1000,
) => {
    let done = false;
    let count = 0;
    const ui = provider.ui();

    do {
        ui.write(`Awaiting transaction completion (${++count}/${maxRetry})`);
        await sleep(interval);
        const api = provider.api();

        const curState = await api.provider(address).getState();

        if (curState.last?.lt !== null) {
            done = curState.last?.lt !== curTxLt;
        }
    } while (!done && count < maxRetry);
    return done;
};
